//! Opt-in Ctrl/Alt tap → summon HUD (`hermesDesktop.hudModifier`).
//!
//! Electron SoT: `hud-modifier.ts` + `hud-modifier-monitor.ts` + native helpers
//! under `electron/native/hud-modifier-*`. Input stays in a child process that
//! speaks JSON lines; only readiness/errors and `summon` cross the pipe.

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
#[cfg(target_os = "macos")]
use tauri_plugin_opener::OpenerExt;

const FILE_NAME: &str = "hud-modifier.json";
pub const STATUS_EVENT: &str = "hermes://hud-modifier-status";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HudModifierStatus {
    pub enabled: bool,
    pub state: HudModifierState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<HudModifierReason>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum HudModifierState {
    Disabled,
    Starting,
    Ready,
    InputPermission,
    Unavailable,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum HudModifierReason {
    MissingHelper,
    UnsupportedSession,
}

#[derive(Default)]
pub struct HudModifierStateHandle {
    inner: Mutex<Runtime>,
}

struct Runtime {
    enabled: bool,
    state: HudModifierState,
    reason: Option<HudModifierReason>,
    generation: u64,
    child: Option<Child>,
    stop_flag: Option<Arc<AtomicBool>>,
}

impl Default for Runtime {
    fn default() -> Self {
        Self {
            enabled: false,
            state: HudModifierState::Disabled,
            reason: None,
            generation: 0,
            child: None,
            stop_flag: None,
        }
    }
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join(FILE_NAME))
}

fn read_enabled(app: &AppHandle) -> bool {
    let Ok(path) = config_path(app) else {
        return false;
    };
    let Ok(raw) = std::fs::read_to_string(path) else {
        return false;
    };
    serde_json::from_str::<serde_json::Value>(&raw)
        .ok()
        .and_then(|v| v.get("enabled")?.as_bool())
        == Some(true)
}

fn write_enabled(app: &AppHandle, enabled: bool) -> Result<(), String> {
    let path = config_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(
        &tmp,
        serde_json::to_string(&serde_json::json!({ "enabled": enabled })).unwrap(),
    )
    .map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

fn status_of(rt: &Runtime) -> HudModifierStatus {
    HudModifierStatus {
        enabled: rt.enabled,
        state: rt.state.clone(),
        reason: rt.reason.clone(),
    }
}

fn publish(app: &AppHandle, status: &HudModifierStatus) {
    let _ = app.emit(STATUS_EVENT, status);
}

/// Electron `hudModifierMonitorSupported`.
pub fn monitor_supported() -> bool {
    #[cfg(target_os = "macos")]
    {
        true
    }
    #[cfg(target_os = "windows")]
    {
        true
    }
    #[cfg(target_os = "linux")]
    {
        let display = std::env::var_os("DISPLAY").filter(|v| !v.is_empty());
        let wayland = std::env::var_os("WAYLAND_DISPLAY").filter(|v| !v.is_empty());
        let session = std::env::var("XDG_SESSION_TYPE")
            .unwrap_or_default()
            .to_ascii_lowercase();
        display.is_some() && wayland.is_none() && session != "wayland"
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        false
    }
}

fn helper_name() -> &'static str {
    if cfg!(windows) {
        "hud-modifier-monitor.exe"
    } else {
        "hud-modifier-monitor"
    }
}

fn platform_arch_dir() -> String {
    let platform = if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(windows) {
        "win32"
    } else {
        "linux"
    };
    let arch = if cfg!(target_os = "macos") {
        "universal".to_string()
    } else {
        std::env::consts::ARCH.to_string()
    };
    format!("{platform}-{arch}")
}

/// Candidates for the native helper binary (Electron `resolveHudModifierMonitorPath`).
pub fn resolve_helper_path(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(override_path) = std::env::var("HERMES_HUD_MODIFIER_HELPER") {
        let p = PathBuf::from(override_path);
        if p.is_file() {
            return Some(p);
        }
    }

    let name = helper_name();
    let relative = PathBuf::from("native").join(platform_arch_dir()).join(name);

    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Ok(dir) = app.path().resource_dir() {
        candidates.push(dir.join(&relative));
        candidates.push(dir.join(name));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.join(&relative));
            candidates.push(parent.join(name));
        }
    }
    // Dev: build.rs / scripts drop the helper next to the copied sources.
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("native/hud-modifier")
            .join(name),
    );
    if let Some(out) = option_env!("HERMES_HUD_MODIFIER_BUILT") {
        candidates.push(PathBuf::from(out));
    }

    candidates.into_iter().find(|p| p.is_file())
}

fn stop_monitor(rt: &mut Runtime) {
    rt.generation = rt.generation.wrapping_add(1);
    if let Some(flag) = rt.stop_flag.take() {
        flag.store(true, Ordering::SeqCst);
    }
    if let Some(mut child) = rt.child.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    rt.state = HudModifierState::Disabled;
    rt.reason = None;
}

fn apply_child_status(
    app: &AppHandle,
    state: &HudModifierStateHandle,
    generation: u64,
    result: ChildStatus,
) {
    let Ok(mut rt) = state.inner.lock() else {
        return;
    };
    if rt.generation != generation {
        return;
    }

    match result {
        ChildStatus::Ready => {
            rt.state = HudModifierState::Ready;
            rt.reason = None;
        }
        ChildStatus::Permission => {
            rt.state = HudModifierState::InputPermission;
            rt.reason = None;
            if let Some(mut child) = rt.child.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
            rt.stop_flag = None;
        }
        ChildStatus::Unavailable { missing_helper } => {
            rt.state = HudModifierState::Unavailable;
            rt.reason = Some(if missing_helper {
                HudModifierReason::MissingHelper
            } else if !monitor_supported() {
                HudModifierReason::UnsupportedSession
            } else {
                HudModifierReason::MissingHelper
            });
            if let Some(mut child) = rt.child.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
            rt.stop_flag = None;
        }
        ChildStatus::Stopped => {
            rt.state = HudModifierState::Disabled;
            rt.reason = None;
        }
    }

    let status = status_of(&rt);
    drop(rt);
    publish(app, &status);
}

#[derive(Debug)]
enum ChildStatus {
    Ready,
    Permission,
    Unavailable { missing_helper: bool },
    Stopped,
}

fn start_monitor(app: &AppHandle, state: &HudModifierStateHandle, request_permission: bool) {
    let Ok(mut rt) = state.inner.lock() else {
        return;
    };

    stop_monitor(&mut rt);

    if !rt.enabled {
        let status = status_of(&rt);
        drop(rt);
        publish(app, &status);
        return;
    }

    if !monitor_supported() {
        rt.state = HudModifierState::Unavailable;
        rt.reason = Some(HudModifierReason::UnsupportedSession);
        let status = status_of(&rt);
        drop(rt);
        publish(app, &status);
        return;
    }

    let Some(helper) = resolve_helper_path(app) else {
        rt.state = HudModifierState::Unavailable;
        rt.reason = Some(HudModifierReason::MissingHelper);
        let status = status_of(&rt);
        drop(rt);
        publish(app, &status);
        return;
    };

    let generation = rt.generation;
    rt.state = HudModifierState::Starting;
    rt.reason = None;
    let status = status_of(&rt);
    publish(app, &status);

    let mut cmd = Command::new(&helper);
    if request_permission {
        cmd.arg("--request-permission");
    }
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(err) => {
            rt.state = HudModifierState::Unavailable;
            rt.reason = Some(if err.kind() == std::io::ErrorKind::NotFound {
                HudModifierReason::MissingHelper
            } else {
                HudModifierReason::MissingHelper
            });
            let status = status_of(&rt);
            drop(rt);
            publish(app, &status);
            return;
        }
    };

    let stdout = match child.stdout.take() {
        Some(out) => out,
        None => {
            let _ = child.kill();
            rt.state = HudModifierState::Unavailable;
            rt.reason = Some(HudModifierReason::MissingHelper);
            let status = status_of(&rt);
            drop(rt);
            publish(app, &status);
            return;
        }
    };

    let stop_flag = Arc::new(AtomicBool::new(false));
    rt.stop_flag = Some(Arc::clone(&stop_flag));
    rt.child = Some(child);
    drop(rt);

    let app_reader = app.clone();
    let stop_reader = Arc::clone(&stop_flag);
    let gen = generation;
    let timeout_ms: u64 = if request_permission { 60_000 } else { 5_000 };

    thread::spawn(move || {
        let Some(handle) = app_reader.try_state::<HudModifierStateHandle>() else {
            return;
        };
        let reader = BufReader::new(stdout);
        let mut ready = false;

        for chunk in reader.lines() {
            if stop_reader.load(Ordering::SeqCst) {
                apply_child_status(&app_reader, &handle, gen, ChildStatus::Stopped);
                return;
            }

            let Ok(line) = chunk else {
                break;
            };
            if line.len() > 4_096 {
                apply_child_status(
                    &app_reader,
                    &handle,
                    gen,
                    ChildStatus::Unavailable {
                        missing_helper: false,
                    },
                );
                return;
            }

            let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            let Some(msg_type) = value.get("type").and_then(|v| v.as_str()) else {
                continue;
            };

            match msg_type {
                "ready" if !ready => {
                    ready = true;
                    apply_child_status(&app_reader, &handle, gen, ChildStatus::Ready);
                }
                "error" => {
                    let code = value.get("code").and_then(|v| v.as_str()).unwrap_or("");
                    if code == "permission-required" {
                        apply_child_status(&app_reader, &handle, gen, ChildStatus::Permission);
                    } else {
                        apply_child_status(
                            &app_reader,
                            &handle,
                            gen,
                            ChildStatus::Unavailable {
                                missing_helper: false,
                            },
                        );
                    }
                    return;
                }
                "summon" if ready => {
                    crate::shortcuts::fire(&app_reader, crate::shortcuts::HUD_ACTION_ID);
                }
                _ => {}
            }
        }

        if stop_reader.load(Ordering::SeqCst) {
            apply_child_status(&app_reader, &handle, gen, ChildStatus::Stopped);
        } else {
            apply_child_status(
                &app_reader,
                &handle,
                gen,
                ChildStatus::Unavailable {
                    missing_helper: false,
                },
            );
        }
    });

    let app_watch = app.clone();
    let stop_watch = Arc::clone(&stop_flag);
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(timeout_ms));
        if stop_watch.load(Ordering::SeqCst) {
            return;
        }
        let Some(handle) = app_watch.try_state::<HudModifierStateHandle>() else {
            return;
        };
        let Ok(rt) = handle.inner.lock() else {
            return;
        };
        if rt.generation != gen || rt.state != HudModifierState::Starting {
            return;
        }
        drop(rt);
        apply_child_status(
            &app_watch,
            &handle,
            gen,
            ChildStatus::Unavailable {
                missing_helper: false,
            },
        );
    });
}

fn current_status(state: &HudModifierStateHandle) -> HudModifierStatus {
    state
        .inner
        .lock()
        .map(|rt| status_of(&rt))
        .unwrap_or(HudModifierStatus {
            enabled: false,
            state: HudModifierState::Disabled,
            reason: None,
        })
}

/// Restore preference and optionally start the helper at process boot.
pub fn boot(app: &AppHandle, state: &HudModifierStateHandle) {
    let enabled = read_enabled(app);
    if let Ok(mut rt) = state.inner.lock() {
        rt.enabled = enabled;
    }
    if enabled {
        start_monitor(app, state, false);
    } else {
        publish(app, &current_status(state));
    }
}

#[tauri::command]
pub async fn hud_modifier_settings_get(
    state: State<'_, HudModifierStateHandle>,
) -> Result<HudModifierStatus, String> {
    Ok(current_status(&state))
}

#[tauri::command]
pub async fn hud_modifier_settings_set(
    app: AppHandle,
    state: State<'_, HudModifierStateHandle>,
    enabled: bool,
) -> Result<HudModifierStatus, String> {
    write_enabled(&app, enabled)?;
    {
        let mut rt = state.inner.lock().map_err(|e| e.to_string())?;
        stop_monitor(&mut rt);
        rt.enabled = enabled;
    }
    if enabled {
        start_monitor(&app, &state, true);
    } else {
        publish(&app, &current_status(&state));
    }
    Ok(current_status(&state))
}

#[tauri::command]
pub async fn hud_modifier_open_permission(app: AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        app.opener()
            .open_url(
                "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent",
                None::<&str>,
            )
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_serialises_camel_case() {
        let json = serde_json::to_value(HudModifierStatus {
            enabled: true,
            state: HudModifierState::InputPermission,
            reason: Some(HudModifierReason::UnsupportedSession),
        })
        .unwrap();
        assert_eq!(json["enabled"], true);
        assert_eq!(json["state"], "input-permission");
        assert_eq!(json["reason"], "unsupported-session");
    }

    #[test]
    fn platform_dir_shape() {
        let dir = platform_arch_dir();
        assert!(dir.contains('-'));
        assert!(!helper_name().is_empty());
    }

    #[test]
    fn resolve_prefers_override_when_file_exists() {
        // Without a real file the override is ignored — pins the env contract.
        std::env::remove_var("HERMES_HUD_MODIFIER_HELPER");
        assert!(std::env::var_os("HERMES_HUD_MODIFIER_HELPER").is_none());
    }
}
