//! Quick Entry settings + OS shortcut (`hermesDesktop.quickEntry`).
//!
//! Electron SoT: `electron/quick-entry.ts` (sanitize / parse / register) +
//! main.ts settings IPC. Window messaging stays on the Tauri event bus
//! (`app/quick-entry/channel.ts`); this module only owns preference + chord.

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState as Edge};

const FILE_NAME: &str = "quick-entry.json";
pub const TOGGLE_EVENT: &str = "hermes://quick-entry-toggle";
pub const DEFAULT_SHORTCUT: &str = "CommandOrControl+Shift+Space";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QuickEntrySettings {
    pub enabled: bool,
    pub shortcut: String,
}

impl Default for QuickEntrySettings {
    fn default() -> Self {
        Self {
            enabled: true,
            shortcut: DEFAULT_SHORTCUT.to_string(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QuickEntryStatus {
    pub enabled: bool,
    pub error: Option<String>,
    pub registered: bool,
    pub shortcut: String,
}

#[derive(Default)]
pub struct QuickEntryState {
    inner: Mutex<Registration>,
}

#[derive(Default)]
struct Registration {
    active: Option<String>,
    error: Option<String>,
    registered: bool,
    shortcut: String,
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join(FILE_NAME))
}

fn read_settings(app: &AppHandle) -> QuickEntrySettings {
    let Ok(path) = config_path(app) else {
        return QuickEntrySettings::default();
    };
    let Ok(raw) = fs::read_to_string(path) else {
        return QuickEntrySettings::default();
    };
    sanitize_settings(&serde_json::from_str::<serde_json::Value>(&raw).unwrap_or_default())
}

fn write_settings(app: &AppHandle, settings: &QuickEntrySettings) -> Result<(), String> {
    let path = config_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(
        &path,
        serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

/// Electron `sanitizeQuickEntrySettings` — malformed/absent → defaults.
pub fn sanitize_settings(raw: &serde_json::Value) -> QuickEntrySettings {
    let enabled = raw.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true);
    let shortcut = raw
        .get("shortcut")
        .and_then(|v| v.as_str())
        .unwrap_or(DEFAULT_SHORTCUT);
    match parse_shortcut(shortcut) {
        Ok(accelerator) => QuickEntrySettings {
            enabled,
            shortcut: accelerator,
        },
        Err(_) => QuickEntrySettings {
            enabled,
            shortcut: DEFAULT_SHORTCUT.to_string(),
        },
    }
}

/// Electron `parseQuickEntryShortcut` — subset used by Settings.
pub fn parse_shortcut(raw: &str) -> Result<String, &'static str> {
    let parts: Vec<&str> = raw
        .split('+')
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .collect();
    if parts.is_empty() {
        return Err("empty");
    }

    const MODIFIERS: &[&str] = &[
        "alt",
        "altgr",
        "cmd",
        "cmdorctrl",
        "command",
        "commandorcontrol",
        "control",
        "ctrl",
        "meta",
        "option",
        "shift",
        "super",
    ];

    let mut modifiers: Vec<String> = Vec::new();
    let mut key: Option<String> = None;

    for part in parts {
        let lower = part.to_ascii_lowercase();
        if MODIFIERS.iter().any(|m| *m == lower) {
            if key.is_some() {
                return Err("invalid-modifier");
            }
            modifiers.push(lower);
            continue;
        }
        if key.is_some() {
            return Err("invalid-key");
        }
        if !is_accelerator_key(&lower) {
            return Err("invalid-key");
        }
        key = Some(lower);
    }

    let key = key.ok_or("no-key")?;
    if modifiers.is_empty() {
        return Err("no-modifier");
    }
    if key == "escape" {
        return Err("reserved");
    }

    let mut seen = std::collections::BTreeSet::new();
    let mut canon_mods = Vec::new();
    for m in modifiers {
        let label = match m.as_str() {
            "cmd" | "command" | "meta" | "super" => "Command",
            "cmdorctrl" | "commandorcontrol" => "CommandOrControl",
            "ctrl" | "control" => "Control",
            "alt" | "option" | "altgr" => "Alt",
            "shift" => "Shift",
            _ => continue,
        };
        if seen.insert(label) {
            canon_mods.push(label.to_string());
        }
    }

    let canon_key = canonical_key(&key);
    Ok(format!("{}+{canon_key}", canon_mods.join("+")))
}

fn is_accelerator_key(token: &str) -> bool {
    const KEYS: &[&str] = &[
        "backspace",
        "delete",
        "down",
        "end",
        "enter",
        "escape",
        "home",
        "insert",
        "left",
        "pagedown",
        "pageup",
        "plus",
        "return",
        "right",
        "space",
        "tab",
        "up",
    ];
    if KEYS.contains(&token) {
        return true;
    }
    if token.len() >= 2
        && token.starts_with('f')
        && token[1..]
            .parse::<u8>()
            .ok()
            .is_some_and(|n| (1..=24).contains(&n))
    {
        return true;
    }
    token.len() == 1
        && (token.as_bytes()[0].is_ascii_alphanumeric()
            || "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~".contains(token))
}

fn canonical_key(key: &str) -> String {
    match key {
        "return" | "enter" => "Return".into(),
        "space" => "Space".into(),
        "plus" => "Plus".into(),
        "tab" => "Tab".into(),
        "backspace" => "Backspace".into(),
        "delete" => "Delete".into(),
        "escape" => "Escape".into(),
        "up" => "Up".into(),
        "down" => "Down".into(),
        "left" => "Left".into(),
        "right" => "Right".into(),
        "home" => "Home".into(),
        "end" => "End".into(),
        "pageup" => "PageUp".into(),
        "pagedown" => "PageDown".into(),
        "insert" => "Insert".into(),
        other if other.len() == 1 => other.to_ascii_uppercase(),
        other if other.starts_with('f') => other.to_ascii_uppercase(),
        other => other.to_string(),
    }
}

fn release(app: &AppHandle, state: &QuickEntryState) {
    let mut reg = state.inner.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(active) = reg.active.take() {
        let _ = app.global_shortcut().unregister(active.as_str());
    }
    reg.registered = false;
    reg.error = None;
}

fn apply(
    app: &AppHandle,
    state: &QuickEntryState,
    settings: &QuickEntrySettings,
) -> QuickEntryStatus {
    release(app, state);

    let mut reg = state.inner.lock().unwrap_or_else(|e| e.into_inner());
    reg.shortcut = settings.shortcut.clone();

    if !settings.enabled {
        reg.registered = false;
        reg.error = None;
        return status_from(&reg, settings.enabled);
    }

    let parsed = match parse_shortcut(&settings.shortcut) {
        Ok(a) => a,
        Err(_) => {
            reg.registered = false;
            reg.error = Some("invalid".into());
            return status_from(&reg, settings.enabled);
        }
    };

    let accelerator = parsed.clone();
    let app_fire = app.clone();
    let ok = app
        .global_shortcut()
        .on_shortcut(accelerator.as_str(), move |_app, _shortcut, event| {
            if event.state == Edge::Pressed {
                let _ = app_fire.emit(TOGGLE_EVENT, ());
            }
        })
        .is_ok();

    if ok {
        reg.active = Some(accelerator.clone());
        reg.shortcut = accelerator;
        reg.registered = true;
        reg.error = None;
    } else {
        reg.active = None;
        reg.shortcut = parsed;
        reg.registered = false;
        reg.error = Some("taken".into());
    }

    status_from(&reg, settings.enabled)
}

fn status_from(reg: &Registration, enabled: bool) -> QuickEntryStatus {
    QuickEntryStatus {
        enabled,
        error: reg.error.clone(),
        registered: reg.registered,
        shortcut: if enabled {
            reg.shortcut.clone()
        } else {
            reg.shortcut.clone()
        },
    }
}

/// Restore the chord on cold launch (main setup).
pub fn boot(app: &AppHandle, state: &QuickEntryState) {
    let settings = read_settings(app);
    let _ = apply(app, state, &settings);
}

#[cfg(desktop)]
#[tauri::command]
pub async fn quick_entry_settings_get(
    app: AppHandle,
    state: State<'_, QuickEntryState>,
) -> Result<QuickEntryStatus, String> {
    let settings = read_settings(&app);
    let reg = state.inner.lock().unwrap_or_else(|e| e.into_inner());
    Ok(QuickEntryStatus {
        enabled: settings.enabled,
        error: reg.error.clone(),
        registered: reg.registered,
        shortcut: if settings.enabled {
            reg.shortcut.clone()
        } else {
            settings.shortcut.clone()
        },
    })
}

#[cfg(desktop)]
#[tauri::command]
pub async fn quick_entry_settings_set(
    app: AppHandle,
    state: State<'_, QuickEntryState>,
    patch: serde_json::Value,
) -> Result<QuickEntryStatus, String> {
    let current = read_settings(&app);
    let enabled = patch
        .get("enabled")
        .and_then(|v| v.as_bool())
        .unwrap_or(current.enabled);
    let shortcut = patch
        .get("shortcut")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(current.shortcut.as_str())
        .to_string();

    let next = match parse_shortcut(&shortcut) {
        Ok(accelerator) => QuickEntrySettings {
            enabled,
            shortcut: accelerator,
        },
        Err(_) if enabled => {
            // Keep prior valid shortcut when the typed one is junk; surface invalid.
            let status = QuickEntryStatus {
                enabled,
                error: Some("invalid".into()),
                registered: false,
                shortcut,
            };
            return Ok(status);
        }
        Err(_) => QuickEntrySettings {
            enabled,
            shortcut: current.shortcut,
        },
    };

    write_settings(&app, &next)?;
    Ok(apply(&app, &state, &next))
}

#[cfg(mobile)]
#[tauri::command]
pub async fn quick_entry_settings_get() -> Result<QuickEntryStatus, String> {
    Err("unsupported_platform".to_string())
}

#[cfg(mobile)]
#[tauri::command]
pub async fn quick_entry_settings_set(
    _patch: serde_json::Value,
) -> Result<QuickEntryStatus, String> {
    Err("unsupported_platform".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_shortcut_parses() {
        assert_eq!(
            parse_shortcut(DEFAULT_SHORTCUT).unwrap(),
            "CommandOrControl+Shift+Space"
        );
    }

    #[test]
    fn rejects_bare_key_and_escape() {
        assert_eq!(parse_shortcut("Space").unwrap_err(), "no-modifier");
        assert_eq!(
            parse_shortcut("CommandOrControl+Escape").unwrap_err(),
            "reserved"
        );
    }

    #[test]
    fn sanitize_falls_back_on_junk_shortcut() {
        let raw = serde_json::json!({ "enabled": true, "shortcut": "nope" });
        let s = sanitize_settings(&raw);
        assert_eq!(s.shortcut, DEFAULT_SHORTCUT);
        assert!(s.enabled);
    }
}
