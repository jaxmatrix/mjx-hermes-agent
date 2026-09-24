//! App / desktop log surface — Electron `desktop.log` + `hermesLog` ring
//! (`hermes:logs:*`, `hermes:fs:logsRoot`).
//!
//! Sits next to `agent.log` under `<HERMES_HOME>/logs/desktop.log`. The backend
//! spawn log is a separate file (`universal-backend.log` via `backend_log.rs`).

use std::collections::VecDeque;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
#[cfg(desktop)]
use tauri_plugin_opener::OpenerExt;

use crate::plugins::hermes_home;

const RING_LINES: usize = 300;
const RECENT_LINES: usize = 200;
const FILE_NAME: &str = "desktop.log";

#[derive(Default)]
pub struct AppLogState {
    ring: Mutex<VecDeque<String>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevealLogsResult {
    pub ok: bool,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Serialize)]
pub struct RecentLogs {
    pub path: String,
    pub lines: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RendererErrorReport {
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub boundary: Option<String>,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub component_stack: Option<String>,
}

fn logs_dir() -> Option<PathBuf> {
    hermes_home().map(|h| h.join("logs"))
}

fn desktop_log_path() -> Option<PathBuf> {
    logs_dir().map(|d| d.join(FILE_NAME))
}

fn stamp_line(line: &str) -> String {
    let stamp = crate::ssh::clock::now_iso8601();
    let redacted = crate::transport::redact_message(line.trim_end().to_string());
    format!("{stamp} {redacted}")
}

fn append_file(path: &PathBuf, text: &str) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{text}");
    }
}

impl AppLogState {
    pub fn push(&self, chunk: &str) {
        let text = chunk.trim();
        if text.is_empty() {
            return;
        }

        let mut stamped = Vec::new();
        for line in text.split('\n') {
            let line = line.trim_end_matches('\r');
            if !line.is_empty() {
                stamped.push(stamp_line(line));
            }
        }
        if stamped.is_empty() {
            return;
        }

        {
            let mut ring = self.ring.lock().unwrap_or_else(|p| p.into_inner());
            for line in &stamped {
                if ring.len() == RING_LINES {
                    ring.pop_front();
                }
                ring.push_back(line.clone());
            }
        }

        if let Some(path) = desktop_log_path() {
            append_file(&path, &stamped.join("\n"));
        }
    }

    pub fn recent(&self) -> Vec<String> {
        let ring = self.ring.lock().unwrap_or_else(|p| p.into_inner());
        ring.iter()
            .skip(ring.len().saturating_sub(RECENT_LINES))
            .cloned()
            .collect()
    }
}

fn clamp(value: Option<&str>, max: usize) -> String {
    value.unwrap_or("").chars().take(max).collect()
}

fn format_renderer_boundary(
    label: Option<&str>,
    boundary: Option<&str>,
    message: Option<&str>,
    stack: Option<&str>,
) -> String {
    let label = clamp(label, 64);
    let boundary = clamp(boundary, 64);
    let message = clamp(message, 2000);
    let head = format!(
        "[renderer crash:{}] [error-boundary:{}] {}",
        if label.is_empty() { "unknown" } else { &label },
        if boundary.is_empty() {
            "unknown"
        } else {
            &boundary
        },
        if message.is_empty() {
            "(no message)"
        } else {
            &message
        }
    );
    let stack = clamp(stack, 4000);
    let stack = stack.trim();
    if stack.is_empty() {
        head
    } else {
        format!("{head}\n{stack}")
    }
}

#[tauri::command]
pub fn logs_root() -> Result<String, String> {
    let dir = logs_dir().ok_or_else(|| "could not resolve HERMES_HOME".to_string())?;
    let _ = fs::create_dir_all(&dir);
    Ok(dir.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn logs_reveal(app: AppHandle) -> RevealLogsResult {
    let Some(path) = desktop_log_path() else {
        return RevealLogsResult {
            ok: false,
            path: String::new(),
            error: Some("could not resolve HERMES_HOME".into()),
        };
    };

    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if !path.exists() {
        let _ = fs::write(&path, b"");
    }

    let path_str = path.to_string_lossy().into_owned();

    #[cfg(desktop)]
    {
        match app.opener().reveal_item_in_dir(&path_str) {
            Ok(()) => RevealLogsResult {
                ok: true,
                path: path_str,
                error: None,
            },
            Err(e) => RevealLogsResult {
                ok: false,
                path: path_str,
                error: Some(e.to_string()),
            },
        }
    }

    #[cfg(mobile)]
    {
        let _ = app;
        RevealLogsResult {
            ok: false,
            path: path_str,
            error: Some("reveal unavailable on this platform".into()),
        }
    }
}

#[tauri::command]
pub fn logs_recent(state: State<'_, AppLogState>) -> RecentLogs {
    let path = desktop_log_path()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    RecentLogs {
        path,
        lines: state.recent(),
    }
}

#[tauri::command]
pub fn report_renderer_error(state: State<'_, AppLogState>, report: RendererErrorReport) {
    let line = format_renderer_boundary(
        report.label.as_deref(),
        report.boundary.as_deref(),
        report.message.as_deref(),
        report.component_stack.as_deref(),
    );
    state.push(&line);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ring_keeps_latest() {
        let state = AppLogState::default();
        for i in 0..350 {
            state.push(&format!("line {i}"));
        }
        let recent = state.recent();
        assert_eq!(recent.len(), RECENT_LINES);
        assert!(recent.last().unwrap().contains("line 349"));
    }

    #[test]
    fn renderer_report_shape() {
        let formatted = format_renderer_boundary(
            Some("main"),
            Some("ErrorBoundary"),
            Some("boom"),
            Some("  in App"),
        );
        assert!(formatted.contains("[renderer crash:main]"));
        assert!(formatted.contains("[error-boundary:ErrorBoundary]"));
        assert!(formatted.contains("boom"));
        assert!(formatted.contains("in App"));
    }
}
