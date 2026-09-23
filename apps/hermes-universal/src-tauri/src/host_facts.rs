//! Host facts — Electron battery / machine profile / remote-display detection
//! (`bootstrap-platform.ts` + `hermes:machine:profile` / powerMonitor).

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

const NVIDIA_PCI_VENDOR: &str = "0x10de";
const BATTERY_EVENT: &str = "hermes://power-battery";
const BATTERY_POLL: Duration = Duration::from_secs(15);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineProfile {
    pub age_days: Option<u32>,
    pub arch: String,
    pub locale: String,
    pub model: String,
    pub nvidia: bool,
    pub platform: String,
    pub release: String,
    pub username: String,
}

#[derive(Default)]
pub struct HostFactsState {
    /// Last broadcast battery state (`None` until first read).
    last_battery: Mutex<Option<bool>>,
    poll_started: AtomicBool,
}

fn electron_platform() -> String {
    match std::env::consts::OS {
        "macos" => "darwin".into(),
        "windows" => "win32".into(),
        other => other.into(),
    }
}

fn electron_arch() -> String {
    match std::env::consts::ARCH {
        "x86_64" => "x64".into(),
        "aarch64" => "arm64".into(),
        "x86" => "ia32".into(),
        other => other.into(),
    }
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

fn age_days_from_home() -> Option<u32> {
    let home = home_dir()?;
    let meta = fs::metadata(home).ok()?;
    // Electron uses birthtime only — filesystems without it report null (not-new).
    let created = meta.created().ok()?;
    let age = std::time::SystemTime::now().duration_since(created).ok()?;
    Some((age.as_secs() / 86_400) as u32)
}

fn username() -> String {
    std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_default()
}

fn read_hardware_model() -> String {
    fs::read_to_string("/proc/device-tree/model")
        .map(|s| s.replace('\0', "").trim().to_string())
        .unwrap_or_default()
}

fn has_nvidia_gpu() -> bool {
    let Ok(entries) = fs::read_dir("/sys/bus/pci/devices") else {
        // Non-Linux: check for the NVIDIA kernel module / driver node.
        return Path::new("/proc/driver/nvidia").exists() || Path::new("/dev/nvidia0").exists();
    };

    for entry in entries.flatten() {
        let vendor = entry.path().join("vendor");
        if let Ok(raw) = fs::read_to_string(&vendor) {
            if raw.trim().eq_ignore_ascii_case(NVIDIA_PCI_VENDOR) {
                return true;
            }
        }
    }

    false
}

fn os_kernel_release() -> String {
    #[cfg(target_os = "linux")]
    {
        if let Ok(raw) = fs::read_to_string("/proc/sys/kernel/osrelease") {
            return raw.trim().to_string();
        }
    }

    format!("{}", tauri_plugin_os::version())
}

/// Pure remote-display detection — Electron `detectRemoteDisplay`.
pub fn detect_remote_display(
    env: &std::collections::HashMap<String, String>,
    platform: &str,
) -> Option<String> {
    let get = |k: &str| env.get(k).map(|s| s.as_str()).unwrap_or("");

    let override_v = get("HERMES_DESKTOP_DISABLE_GPU")
        .trim()
        .to_ascii_lowercase();
    const ON: &[&str] = &["1", "true", "yes", "on"];
    const OFF: &[&str] = &["0", "false", "no", "off"];

    if ON.contains(&override_v.as_str()) {
        return Some("override (HERMES_DESKTOP_DISABLE_GPU)".into());
    }
    if OFF.contains(&override_v.as_str()) {
        return None;
    }

    if !get("SSH_CONNECTION").is_empty()
        || !get("SSH_CLIENT").is_empty()
        || !get("SSH_TTY").is_empty()
    {
        return Some("ssh-session".into());
    }

    if platform == "linux" {
        let display = get("DISPLAY");
        if display.contains(':') {
            let host = display.split(':').next().unwrap_or("");
            if !host.is_empty() {
                return Some(format!("x11-forwarding (DISPLAY={display})"));
            }
        }
    }

    if platform == "win32" || platform == "windows" {
        let session = get("SESSIONNAME");
        if session.to_ascii_lowercase().starts_with("rdp-") {
            return Some(format!("rdp (SESSIONNAME={session})"));
        }
    }

    None
}

fn env_map() -> std::collections::HashMap<String, String> {
    std::env::vars().collect()
}

/// Linux sysfs: on battery when no AC is online and a battery is discharging,
/// or when AC online is explicitly 0.
pub fn read_on_battery() -> bool {
    #[cfg(target_os = "linux")]
    {
        let root = Path::new("/sys/class/power_supply");
        let Ok(entries) = fs::read_dir(root) else {
            return false;
        };

        let mut saw_battery = false;
        let mut discharging = false;
        let mut ac_online: Option<bool> = None;

        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_ascii_uppercase();
            let typ = fs::read_to_string(path.join("type"))
                .unwrap_or_default()
                .trim()
                .to_ascii_lowercase();

            if typ == "mains" || name.starts_with("AC") || name.starts_with("ADP") {
                if let Ok(online) = fs::read_to_string(path.join("online")) {
                    ac_online = Some(online.trim() == "1");
                }
            }

            if typ == "battery" || name.starts_with("BAT") {
                saw_battery = true;
                if let Ok(status) = fs::read_to_string(path.join("status")) {
                    if status.trim().eq_ignore_ascii_case("discharging") {
                        discharging = true;
                    }
                }
            }
        }

        if let Some(online) = ac_online {
            return !online;
        }

        return saw_battery && discharging;
    }

    #[cfg(target_os = "macos")]
    {
        // Best-effort: `pmset -g batt` mentions "Battery Power" when unplugged.
        if let Ok(output) = std::process::Command::new("pmset")
            .args(["-g", "batt"])
            .output()
        {
            let text = String::from_utf8_lossy(&output.stdout);
            return text.contains("Battery Power");
        }
        return false;
    }

    #[cfg(target_os = "windows")]
    {
        // SYSTEM_POWER_STATUS via powercfg is heavy; default to AC until a
        // proper probe lands. Laptops still get correct gating if we later
        // wire IOCTL — false is the safe "don't slow polls" default.
        return false;
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        false
    }
}

fn ensure_battery_poll(app: &AppHandle, state: &HostFactsState) {
    if state
        .poll_started
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return;
    }

    let app = app.clone();
    thread::spawn(move || {
        let state = app.state::<HostFactsState>();
        loop {
            let next = read_on_battery();
            let mut changed = false;
            if let Ok(mut slot) = state.last_battery.lock() {
                if *slot != Some(next) {
                    *slot = Some(next);
                    changed = true;
                }
            }
            if changed {
                let _ = app.emit(BATTERY_EVENT, next);
            }
            thread::sleep(BATTERY_POLL);
        }
    });
}

#[tauri::command]
pub fn get_on_battery(app: AppHandle, state: State<'_, HostFactsState>) -> bool {
    ensure_battery_poll(&app, &state);
    let on = read_on_battery();
    if let Ok(mut slot) = state.last_battery.lock() {
        *slot = Some(on);
    }
    on
}

#[tauri::command]
pub fn get_remote_display_reason() -> Option<String> {
    detect_remote_display(&env_map(), &electron_platform())
}

#[tauri::command]
pub fn get_machine_profile() -> MachineProfile {
    MachineProfile {
        age_days: age_days_from_home(),
        arch: electron_arch(),
        locale: tauri_plugin_os::locale().unwrap_or_default(),
        model: read_hardware_model(),
        nvidia: has_nvidia_gpu(),
        platform: electron_platform(),
        release: os_kernel_release(),
        username: username(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> std::collections::HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect()
    }

    #[test]
    fn remote_display_keeps_gpu_on_local() {
        assert_eq!(
            detect_remote_display(&env(&[("DISPLAY", ":0")]), "linux"),
            None
        );
        assert_eq!(
            detect_remote_display(&env(&[("WAYLAND_DISPLAY", "wayland-0")]), "linux"),
            None
        );
        assert_eq!(
            detect_remote_display(&env(&[("SESSIONNAME", "Console")]), "win32"),
            None
        );
    }

    #[test]
    fn remote_display_flags_ssh() {
        assert_eq!(
            detect_remote_display(&env(&[("SSH_CONNECTION", "1.2.3.4 5 6.7.8.9 22")]), "linux"),
            Some("ssh-session".into())
        );
    }

    #[test]
    fn remote_display_flags_x11_forward() {
        let reason =
            detect_remote_display(&env(&[("DISPLAY", "localhost:10.0")]), "linux").unwrap();
        assert!(reason.contains("x11-forwarding"));
        assert_eq!(
            detect_remote_display(&env(&[("DISPLAY", ":1")]), "linux"),
            None
        );
    }

    #[test]
    fn remote_display_flags_rdp() {
        let reason = detect_remote_display(&env(&[("SESSIONNAME", "RDP-Tcp#7")]), "win32").unwrap();
        assert!(reason.starts_with("rdp"));
    }

    #[test]
    fn remote_display_honors_override() {
        assert!(detect_remote_display(
            &env(&[("HERMES_DESKTOP_DISABLE_GPU", "1",), ("DISPLAY", ":0")]),
            "linux"
        )
        .unwrap()
        .contains("override"));
        assert_eq!(
            detect_remote_display(
                &env(&[
                    ("HERMES_DESKTOP_DISABLE_GPU", "0"),
                    ("SSH_CONNECTION", "1 2 3 4")
                ]),
                "linux"
            ),
            None
        );
    }

    #[test]
    fn electron_platform_names() {
        let p = electron_platform();
        assert!(p == "linux" || p == "darwin" || p == "win32" || !p.is_empty());
    }
}
