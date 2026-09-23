//! App-wide default profile route — Electron `desktop-profile.ts`
//! (`hermes:profile:default:*`, persisted in `active-profile.json`).

use std::fs;
use std::path::PathBuf;
use std::sync::OnceLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

const FILE_NAME: &str = "active-profile.json";
pub const CHANGED_EVENT: &str = "hermes://profile-default-changed";

fn profile_name_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[a-z0-9][a-z0-9_-]{0,63}$").expect("profile name regex"))
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopProfileRoute {
    pub connection_id: Option<String>,
    pub profile: String,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PreferencesFile {
    #[serde(default)]
    default_route: Option<DesktopProfileRoute>,
    #[serde(default)]
    profile: Option<String>,
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join(FILE_NAME))
}

fn read_file(path: &PathBuf) -> PreferencesFile {
    let Ok(raw) = fs::read_to_string(path) else {
        return PreferencesFile::default();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

fn write_file(path: &PathBuf, value: &PreferencesFile) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    let body = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    fs::write(&tmp, body).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

fn require_route(route: DesktopProfileRoute) -> Result<DesktopProfileRoute, String> {
    if !profile_name_re().is_match(&route.profile) {
        return Err("Invalid profile name.".into());
    }
    if let Some(ref id) = route.connection_id {
        if id.is_empty() || id.trim() != id.as_str() {
            return Err("Invalid connection id.".into());
        }
    }
    Ok(route)
}

#[tauri::command]
pub fn profile_default_get(app: AppHandle) -> Option<DesktopProfileRoute> {
    let Ok(path) = config_path(&app) else {
        return None;
    };
    read_file(&path)
        .default_route
        .and_then(|r| require_route(r).ok())
}

#[tauri::command]
pub fn profile_default_set(
    app: AppHandle,
    route: DesktopProfileRoute,
) -> Result<DesktopProfileRoute, String> {
    let route = require_route(route)?;
    let path = config_path(&app)?;
    let mut file = read_file(&path);
    file.default_route = Some(route.clone());
    write_file(&path, &file)?;
    let _ = app.emit(CHANGED_EVENT, &route);
    Ok(route)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_bad_profile_names() {
        assert!(require_route(DesktopProfileRoute {
            connection_id: None,
            profile: "Bad Name".into(),
        })
        .is_err());
        assert!(require_route(DesktopProfileRoute {
            connection_id: Some("lab".into()),
            profile: "research".into(),
        })
        .is_ok());
    }
}
