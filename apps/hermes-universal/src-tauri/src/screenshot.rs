//! macOS Cmd+Shift+4-style gesture → attach a window screenshot.
//!
//! Electron SoT: `command-screenshot.ts` + monitor/capture helpers. Non-macOS
//! keeps the settings API but reports `unavailable` (preload AST lists the API
//! for every platform via the darwin ternary's true branch).

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
#[cfg(target_os = "macos")]
use tauri_plugin_opener::OpenerExt;

const FILE_NAME: &str = "screenshot.json";
pub const STATUS_EVENT: &str = "hermes://screenshot-status";
pub const REQUEST_EVENT: &str = "hermes://screenshot-request";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotStatus {
    pub enabled: bool,
    pub state: ScreenshotState,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum ScreenshotState {
    Disabled,
    Starting,
    Ready,
    InputPermission,
    ScreenPermission,
    Unavailable,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotWindow {
    pub window_id: u32,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ScreenshotResult {
    Ok { ok: bool, png: Vec<u8> },
    Err { ok: bool, reason: String },
}

impl ScreenshotResult {
    fn ok_png(png: Vec<u8>) -> Self {
        Self::Ok { ok: true, png }
    }

    fn err(reason: &str) -> Self {
        Self::Err {
            ok: false,
            reason: reason.to_string(),
        }
    }
}

#[derive(Default)]
pub struct ScreenshotStateHandle {
    inner: Mutex<Runtime>,
}

struct Runtime {
    enabled: bool,
    monitor_state: ScreenshotState,
    generation: u64,
    child: Option<Child>,
    stop_flag: Option<Arc<AtomicBool>>,
    pending: Option<PendingCapture>,
    busy: bool,
    /// Webview labels that subscribed for gesture requests.
    recipients: HashMap<String, ()>,
    last_recipient: Option<String>,
}

struct PendingCapture {
    id: String,
    owner: String,
    window: ScreenshotWindow,
    expires: Instant,
}

impl Default for Runtime {
    fn default() -> Self {
        Self {
            enabled: false,
            monitor_state: ScreenshotState::Disabled,
            generation: 0,
            child: None,
            stop_flag: None,
            pending: None,
            busy: false,
            recipients: HashMap::new(),
            last_recipient: None,
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

fn platform_is_macos() -> bool {
    cfg!(target_os = "macos")
}

fn status_of(rt: &Runtime) -> ScreenshotStatus {
    let state = if !rt.enabled {
        ScreenshotState::Disabled
    } else if !platform_is_macos() {
        ScreenshotState::Unavailable
    } else {
        rt.monitor_state.clone()
    };
    ScreenshotStatus {
        enabled: rt.enabled,
        state,
    }
}

fn publish(app: &AppHandle, status: &ScreenshotStatus) {
    let _ = app.emit(STATUS_EVENT, status);
}

fn helper_name() -> &'static str {
    "command-screenshot-monitor"
}

fn resolve_helper_path(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(override_path) = std::env::var("HERMES_SCREENSHOT_HELPER") {
        let p = PathBuf::from(override_path);
        if p.is_file() {
            return Some(p);
        }
    }
    let name = helper_name();
    let mut candidates = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        candidates.push(dir.join("native").join(name));
        candidates.push(dir.join(name));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.join("native").join(name));
            candidates.push(parent.join(name));
        }
    }
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("native/screenshot")
            .join(name),
    );
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
    rt.pending = None;
    rt.monitor_state = ScreenshotState::Disabled;
}

fn start_monitor(app: &AppHandle, state: &ScreenshotStateHandle, request_permission: bool) {
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

    if !platform_is_macos() {
        rt.monitor_state = ScreenshotState::Unavailable;
        let status = status_of(&rt);
        drop(rt);
        publish(app, &status);
        return;
    }

    let Some(helper) = resolve_helper_path(app) else {
        rt.monitor_state = ScreenshotState::Unavailable;
        let status = status_of(&rt);
        drop(rt);
        publish(app, &status);
        return;
    };

    let generation = rt.generation;
    rt.monitor_state = ScreenshotState::Starting;
    let status = status_of(&rt);
    publish(app, &status);

    let mut cmd = Command::new(&helper);
    if request_permission {
        cmd.arg("--request-permission");
    }
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(_) => {
            rt.monitor_state = ScreenshotState::Unavailable;
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
            rt.monitor_state = ScreenshotState::Unavailable;
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
        let Some(handle) = app_reader.try_state::<ScreenshotStateHandle>() else {
            return;
        };
        let reader = BufReader::new(stdout);
        let mut ready = false;

        for chunk in reader.lines() {
            if stop_reader.load(Ordering::SeqCst) {
                return;
            }
            let Ok(line) = chunk else {
                break;
            };
            let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            let Some(msg_type) = value.get("type").and_then(|v| v.as_str()) else {
                continue;
            };

            match msg_type {
                "ready" if !ready => {
                    ready = true;
                    if let Ok(mut rt) = handle.inner.lock() {
                        if rt.generation == gen {
                            rt.monitor_state = ScreenshotState::Ready;
                            let status = status_of(&rt);
                            drop(rt);
                            publish(&app_reader, &status);
                        }
                    }
                }
                "error" => {
                    let code = value.get("code").and_then(|v| v.as_str()).unwrap_or("");
                    if let Ok(mut rt) = handle.inner.lock() {
                        if rt.generation == gen {
                            rt.monitor_state = if code == "permission-required" {
                                ScreenshotState::InputPermission
                            } else {
                                ScreenshotState::Unavailable
                            };
                            let status = status_of(&rt);
                            drop(rt);
                            publish(&app_reader, &status);
                        }
                    }
                    return;
                }
                "capture" if ready => {
                    let window_id =
                        value.get("windowId").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                    let width = value.get("width").and_then(|v| v.as_f64()).unwrap_or(0.0);
                    let height = value.get("height").and_then(|v| v.as_f64()).unwrap_or(0.0);
                    if window_id == 0 || width <= 0.0 || height <= 0.0 {
                        continue;
                    }
                    let window = ScreenshotWindow {
                        window_id,
                        width,
                        height,
                    };
                    let request_id = {
                        let Ok(mut rt) = handle.inner.lock() else {
                            continue;
                        };
                        if rt.generation != gen || rt.busy {
                            continue;
                        }
                        if rt
                            .pending
                            .as_ref()
                            .is_some_and(|p| p.expires > Instant::now())
                        {
                            continue;
                        }
                        let owner = rt
                            .last_recipient
                            .clone()
                            .or_else(|| rt.recipients.keys().next().cloned());
                        let Some(owner) = owner else {
                            continue;
                        };
                        if !rt.recipients.contains_key(&owner) {
                            continue;
                        }
                        let id = format!(
                            "ss-{}-{}",
                            std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .map(|d| d.as_nanos())
                                .unwrap_or(0),
                            rt.generation
                        );
                        rt.pending = Some(PendingCapture {
                            id: id.clone(),
                            owner: owner.clone(),
                            window,
                            expires: Instant::now() + Duration::from_secs(5),
                        });
                        let _ = app_reader.emit_to(&owner, REQUEST_EVENT, &id);
                        id
                    };
                    let _ = request_id;
                }
                _ => {}
            }
        }
    });

    let app_watch = app.clone();
    let stop_watch = Arc::clone(&stop_flag);
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(timeout_ms));
        if stop_watch.load(Ordering::SeqCst) {
            return;
        }
        let Some(handle) = app_watch.try_state::<ScreenshotStateHandle>() else {
            return;
        };
        let status = {
            let Ok(mut rt) = handle.inner.lock() else {
                return;
            };
            if rt.generation == gen && rt.monitor_state == ScreenshotState::Starting {
                rt.monitor_state = ScreenshotState::Unavailable;
                Some(status_of(&rt))
            } else {
                None
            }
        };
        if let Some(status) = status {
            publish(&app_watch, &status);
        }
    });
}

fn current_status(state: &ScreenshotStateHandle) -> ScreenshotStatus {
    state
        .inner
        .lock()
        .map(|rt| status_of(&rt))
        .unwrap_or(ScreenshotStatus {
            enabled: false,
            state: ScreenshotState::Disabled,
        })
}

pub fn boot(app: &AppHandle, state: &ScreenshotStateHandle) {
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
pub async fn screenshot_settings_get(
    state: State<'_, ScreenshotStateHandle>,
) -> Result<ScreenshotStatus, String> {
    Ok(current_status(&state))
}

#[tauri::command]
pub async fn screenshot_settings_set(
    app: AppHandle,
    state: State<'_, ScreenshotStateHandle>,
    enabled: bool,
) -> Result<ScreenshotStatus, String> {
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
pub async fn screenshot_open_permission(app: AppHandle, kind: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let pane = match kind.as_str() {
            "input" => "Privacy_ListenEvent",
            "screen" => "Privacy_ScreenCapture",
            _ => return Err("Unknown screenshot permission".into()),
        };
        app.opener()
            .open_url(
                &format!("x-apple.systempreferences:com.apple.preference.security?{pane}"),
                None::<&str>,
            )
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, kind);
    }
    Ok(())
}

#[tauri::command]
pub async fn screenshot_subscribe(
    window: tauri::WebviewWindow,
    state: State<'_, ScreenshotStateHandle>,
    subscribed: bool,
) -> Result<(), String> {
    let label = window.label().to_string();
    let mut rt = state.inner.lock().map_err(|e| e.to_string())?;
    if subscribed {
        rt.recipients.insert(label.clone(), ());
        rt.last_recipient = Some(label);
    } else {
        rt.recipients.remove(&label);
        if rt.last_recipient.as_deref() == Some(label.as_str()) {
            rt.last_recipient = None;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn screenshot_capture(
    window: tauri::WebviewWindow,
    state: State<'_, ScreenshotStateHandle>,
    request_id: String,
) -> Result<ScreenshotResult, String> {
    let label = window.label().to_string();
    let mut rt = state.inner.lock().map_err(|e| e.to_string())?;

    let Some(pending) = rt.pending.take() else {
        return Ok(ScreenshotResult::err("expired"));
    };
    if pending.id != request_id || pending.owner != label {
        rt.pending = Some(pending);
        return Ok(ScreenshotResult::err("expired"));
    }
    if pending.expires <= Instant::now() {
        return Ok(ScreenshotResult::err("expired"));
    }

    // macOS: `screencapture -l <CGWindowID>` captures the gestured window.
    #[cfg(target_os = "macos")]
    {
        let window_id = pending.window.window_id;
        rt.busy = true;
        drop(rt);

        let path = std::env::temp_dir().join(format!("hermes-ss-{request_id}.png"));
        let status = Command::new("screencapture")
            .args([
                "-l",
                &window_id.to_string(),
                "-x",
                path.to_str().unwrap_or("/tmp/hermes-ss.png"),
            ])
            .status();

        let result = match status {
            Ok(s) if s.success() => match std::fs::read(&path) {
                Ok(png) if !png.is_empty() => ScreenshotResult::ok_png(png),
                _ => ScreenshotResult::err("unavailable"),
            },
            _ => ScreenshotResult::err("unavailable"),
        };
        let _ = std::fs::remove_file(&path);

        if let Ok(mut rt) = state.inner.lock() {
            rt.busy = false;
        }
        return Ok(result);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = pending;
        Ok(ScreenshotResult::err("unavailable"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_serialises_kebab_states() {
        let json = serde_json::to_value(ScreenshotStatus {
            enabled: true,
            state: ScreenshotState::ScreenPermission,
        })
        .unwrap();
        assert_eq!(json["state"], "screen-permission");
    }

    #[test]
    fn result_shapes() {
        let ok = serde_json::to_value(ScreenshotResult::ok_png(vec![1, 2, 3])).unwrap();
        assert_eq!(ok["ok"], true);
        let err = serde_json::to_value(ScreenshotResult::err("expired")).unwrap();
        assert_eq!(err["ok"], false);
        assert_eq!(err["reason"], "expired");
    }
}
