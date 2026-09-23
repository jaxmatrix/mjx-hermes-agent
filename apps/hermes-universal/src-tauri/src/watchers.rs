//! Preview / plugin-root file watchers — Electron `watchPreviewFile`,
//! `watchDirectory`, `stopPreviewFileWatch`, `onPreviewFileChanged`.
//!
//! Desktop-only. Debounced 120 ms to match Electron `PREVIEW_WATCH_DEBOUNCE_MS`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use base64::Engine as _;
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use url::Url;

const DEBOUNCE_MS: u64 = 120;
pub const PREVIEW_FILE_CHANGED_EVENT: &str = "hermes://preview-file-changed";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewWatch {
    pub id: String,
    pub path: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewFileChanged {
    pub id: String,
    pub path: String,
    pub url: String,
}

struct ActiveWatch {
    stop: Arc<AtomicBool>,
    _watcher: RecommendedWatcher,
}

#[derive(Default)]
pub struct WatchersState {
    entries: Mutex<HashMap<String, ActiveWatch>>,
}

fn new_watch_id() -> String {
    let mut buf = [0u8; 12];
    let _ = getrandom::getrandom(&mut buf);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buf)
}

fn expand_user_path(raw: &str, home: &Path) -> PathBuf {
    let value = raw.trim();
    if value == "~" {
        return home.to_path_buf();
    }
    if let Some(rest) = value
        .strip_prefix("~/")
        .or_else(|| value.strip_prefix("~\\"))
    {
        return home.join(rest);
    }
    PathBuf::from(value)
}

fn file_url_to_path(raw: &str) -> Option<PathBuf> {
    let url = raw.trim();
    if !url.to_ascii_lowercase().starts_with("file:") {
        return None;
    }
    let parsed = Url::parse(url).ok()?;
    if parsed.scheme() != "file" {
        return None;
    }
    let path = percent_encoding::percent_decode(parsed.path().as_bytes())
        .decode_utf8()
        .ok()?
        .into_owned();
    let path = if path.len() >= 3
        && path.as_bytes()[0] == b'/'
        && path.as_bytes()[1].is_ascii_alphabetic()
        && path.as_bytes()[2] == b':'
    {
        path[1..].to_string()
    } else {
        path
    };
    Some(PathBuf::from(path))
}

fn resolve_file_path(app: &AppHandle, raw: &str) -> Result<PathBuf, String> {
    let home = app.path().home_dir().unwrap_or_else(|_| PathBuf::from("."));
    let resolved = file_url_to_path(raw).unwrap_or_else(|| expand_user_path(raw, &home));
    if !resolved.is_file() {
        return Err(format!(
            "Preview file watch failed: not a file ({resolved:?})."
        ));
    }
    Ok(resolved)
}

fn path_to_file_url(path: &Path) -> String {
    Url::from_file_path(path)
        .map(|u| u.to_string())
        .unwrap_or_else(|_| path.to_string_lossy().into_owned())
}

fn start_watch(
    app: AppHandle,
    id: String,
    watch_dir: PathBuf,
    filter_name: Option<String>,
    emit_path: PathBuf,
    require_file: bool,
) -> Result<ActiveWatch, String> {
    let (tx, rx) = std::sync::mpsc::channel::<Result<notify::Event, notify::Error>>();
    let mut watcher = notify::recommended_watcher(tx).map_err(|e| format!("watch failed: {e}"))?;
    watcher
        .watch(&watch_dir, RecursiveMode::NonRecursive)
        .map_err(|e| format!("watch failed: {e}"))?;

    let stop = Arc::new(AtomicBool::new(false));
    let stop_flag = Arc::clone(&stop);
    let debounce = Duration::from_millis(DEBOUNCE_MS);

    thread::spawn(move || {
        let mut pending_at: Option<Instant> = None;

        loop {
            if stop_flag.load(Ordering::Relaxed) {
                break;
            }

            let wait = pending_at
                .map(|at| at.saturating_duration_since(Instant::now()))
                .unwrap_or(Duration::from_millis(200));

            match rx.recv_timeout(wait.max(Duration::from_millis(1))) {
                Ok(Ok(event)) => {
                    if matches!(event.kind, EventKind::Access(_)) {
                        continue;
                    }

                    let relevant = match &filter_name {
                        None => true,
                        Some(name) => {
                            if event.paths.is_empty() {
                                true
                            } else {
                                event.paths.iter().any(|p| {
                                    p.file_name()
                                        .and_then(|n| n.to_str())
                                        .map(|n| n == name)
                                        .unwrap_or(false)
                                })
                            }
                        }
                    };

                    if relevant {
                        pending_at = Some(Instant::now() + debounce);
                    }
                }
                Ok(Err(_)) => break,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    if let Some(at) = pending_at {
                        if Instant::now() >= at {
                            pending_at = None;
                            if require_file && !emit_path.is_file() {
                                continue;
                            }
                            let payload = PreviewFileChanged {
                                id: id.clone(),
                                path: emit_path.to_string_lossy().into_owned(),
                                url: path_to_file_url(&emit_path),
                            };
                            let _ = app.emit(PREVIEW_FILE_CHANGED_EVENT, payload);
                        }
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
    });

    Ok(ActiveWatch {
        stop,
        _watcher: watcher,
    })
}

fn insert_watch(state: &WatchersState, id: String, watch: ActiveWatch) {
    if let Ok(mut map) = state.entries.lock() {
        map.insert(id, watch);
    }
}

#[tauri::command]
pub fn watch_preview_file(
    app: AppHandle,
    state: State<'_, WatchersState>,
    url: String,
) -> Result<PreviewWatch, String> {
    let file_path = resolve_file_path(&app, &url)?;
    let watch_dir = file_path
        .parent()
        .ok_or_else(|| "Preview file watch failed: no parent directory.".to_string())?
        .to_path_buf();
    let target_name = file_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();

    let id = new_watch_id();
    let watch = start_watch(
        app,
        id.clone(),
        watch_dir,
        Some(target_name),
        file_path.clone(),
        true,
    )?;
    insert_watch(&state, id.clone(), watch);

    Ok(PreviewWatch {
        id,
        path: file_path.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
pub fn watch_directory(
    app: AppHandle,
    state: State<'_, WatchersState>,
    dir: String,
) -> Result<PreviewWatch, String> {
    let home = app.path().home_dir().unwrap_or_else(|_| PathBuf::from("."));
    let watch_dir = expand_user_path(dir.trim(), &home);
    let watch_dir = watch_dir.canonicalize().unwrap_or(watch_dir);

    if !watch_dir.is_dir() {
        return Err(format!("Not a directory: {}", watch_dir.display()));
    }

    let id = new_watch_id();
    let watch = start_watch(
        app,
        id.clone(),
        watch_dir.clone(),
        None,
        watch_dir.clone(),
        false,
    )?;
    insert_watch(&state, id.clone(), watch);

    Ok(PreviewWatch {
        id,
        path: watch_dir.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
pub fn stop_preview_file_watch(state: State<'_, WatchersState>, id: String) -> bool {
    let removed = state
        .entries
        .lock()
        .ok()
        .and_then(|mut map| map.remove(&id));

    if let Some(watch) = removed {
        watch.stop.store(true, Ordering::Relaxed);
        true
    } else {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_url_roundtrip_shape() {
        let path = file_url_to_path("file:///tmp/preview.txt").expect("path");
        assert_eq!(path, PathBuf::from("/tmp/preview.txt"));
    }

    #[test]
    fn debounce_constant_matches_electron() {
        assert_eq!(DEBOUNCE_MS, 120);
    }
}
