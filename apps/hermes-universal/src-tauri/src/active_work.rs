//! Quit-guard active-work reports — Electron `quit-guard.ts` + `hermes:active-work`.
//!
//! Each webview publishes which chats are mid-turn; on `ExitRequested` we merge
//! them and ask before killing a turn in flight.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::Deserialize;
use tauri::{AppHandle, Manager, State, Webview};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

const MAX_LISTED: usize = 4;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ActiveWork {
    pub titles: Vec<String>,
    pub count: usize,
}

#[derive(Deserialize)]
pub struct ActiveWorkPayload {
    #[serde(default)]
    titles: Option<Vec<serde_json::Value>>,
    #[serde(default)]
    count: Option<serde_json::Value>,
}

pub struct QuitPrompt {
    pub message: String,
    pub detail: String,
}

#[derive(Default)]
pub struct ActiveWorkState {
    by_label: Mutex<HashMap<String, ActiveWork>>,
    confirmed: AtomicBool,
    prompt_open: AtomicBool,
}

pub fn normalize(payload: ActiveWorkPayload) -> ActiveWork {
    let titles: Vec<String> = payload
        .titles
        .unwrap_or_default()
        .into_iter()
        .filter_map(|v| v.as_str().map(|s| s.trim().to_string()))
        .filter(|s| !s.is_empty())
        .collect();

    let count = match payload.count {
        Some(serde_json::Value::Number(n)) => n
            .as_f64()
            .filter(|f| f.is_finite())
            .map(|f| f.max(0.0).floor() as usize)
            .unwrap_or(0),
        _ => 0,
    };

    ActiveWork {
        count: count.max(titles.len()),
        titles,
    }
}

pub fn merge<'a>(reports: impl IntoIterator<Item = &'a ActiveWork>) -> ActiveWork {
    let mut titles = Vec::new();
    let mut count = 0usize;

    for report in reports {
        count = count.max(report.count);
        for title in &report.titles {
            if !titles.iter().any(|t| t == title) {
                titles.push(title.clone());
            }
        }
    }

    ActiveWork {
        count: count.max(titles.len()),
        titles,
    }
}

pub fn quit_prompt(work: &ActiveWork, quitting_for_handoff: bool) -> Option<QuitPrompt> {
    if quitting_for_handoff || work.count < 1 {
        return None;
    }

    let listed: Vec<_> = work.titles.iter().take(MAX_LISTED).cloned().collect();
    let remaining = work.count.saturating_sub(listed.len());
    let mut lines: Vec<String> = listed.iter().map(|t| format!("• {t}")).collect();
    if remaining > 0 {
        lines.push(if remaining == 1 {
            "• 1 more".into()
        } else {
            format!("• {remaining} more")
        });
    }

    let mut detail_parts = Vec::new();
    if !lines.is_empty() {
        detail_parts.push(lines.join("\n"));
        detail_parts.push(String::new());
    }
    detail_parts.push(
        "Quitting stops the agent mid-turn. Any work it has not finished writing is lost.".into(),
    );

    Some(QuitPrompt {
        message: if work.count == 1 {
            "Hermes is still working on 1 chat.".into()
        } else {
            format!("Hermes is still working on {} chats.", work.count)
        },
        detail: detail_parts.join("\n").trim().to_string(),
    })
}

impl ActiveWorkState {
    pub fn set(&self, label: &str, work: ActiveWork) {
        let mut map = self.by_label.lock().unwrap_or_else(|p| p.into_inner());
        if work.count == 0 && work.titles.is_empty() {
            map.remove(label);
        } else {
            map.insert(label.to_string(), work);
        }
    }

    pub fn forget(&self, label: &str) {
        self.by_label
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(label);
    }

    pub fn merged(&self) -> ActiveWork {
        let map = self.by_label.lock().unwrap_or_else(|p| p.into_inner());
        merge(map.values())
    }

    pub fn confirmed(&self) -> bool {
        self.confirmed.load(Ordering::SeqCst)
    }

    pub fn confirm(&self) {
        self.confirmed.store(true, Ordering::SeqCst);
    }

    pub fn prompt_open(&self) -> bool {
        self.prompt_open.load(Ordering::SeqCst)
    }

    pub fn set_prompt_open(&self, open: bool) {
        self.prompt_open.store(open, Ordering::SeqCst);
    }
}

#[tauri::command]
pub fn set_active_work(
    webview: Webview,
    state: State<'_, ActiveWorkState>,
    payload: ActiveWorkPayload,
) {
    state.set(webview.label(), normalize(payload));
}

/// Intercept an exit that would kill mid-turn work. Returns true when the exit
/// was held (caller must `prevent_exit`).
pub fn hold_exit_for_active_work(app: &AppHandle) -> bool {
    let Some(state) = app.try_state::<ActiveWorkState>() else {
        return false;
    };

    if state.confirmed() {
        return false;
    }

    if state.prompt_open() {
        return true;
    }

    let Some(prompt) = quit_prompt(&state.merged(), false) else {
        return false;
    };

    state.set_prompt_open(true);
    let app = app.clone();
    let body = format!("{}\n\n{}", prompt.message, prompt.detail);

    app.dialog()
        .message(body)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Quit Anyway".into(),
            "Keep Running".into(),
        ))
        .show(move |quit_anyway| {
            let Some(state) = app.try_state::<ActiveWorkState>() else {
                return;
            };
            state.set_prompt_open(false);
            if quit_anyway {
                state.confirm();
                if let Some(bg) = app.try_state::<crate::background::BackgroundState>() {
                    bg.request_quit();
                }
                #[cfg(desktop)]
                {
                    crate::shortcuts::release_all(&app);
                    crate::window::close_satellite_windows(&app);
                }
                app.exit(0);
            }
        });

    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn normalize_drops_junk() {
        let work = normalize(ActiveWorkPayload {
            titles: Some(vec![json!("  Fix login  "), json!(""), json!(7)]),
            count: Some(json!(-3)),
        });
        assert_eq!(
            work,
            ActiveWork {
                count: 1,
                titles: vec!["Fix login".into()]
            }
        );
    }

    #[test]
    fn merge_dedupes_titles() {
        let a = ActiveWork {
            count: 2,
            titles: vec!["A".into(), "B".into()],
        };
        let b = ActiveWork {
            count: 1,
            titles: vec!["B".into()],
        };
        let merged = merge([&a, &b]);
        assert_eq!(merged.count, 2);
        assert_eq!(merged.titles, vec!["A".to_string(), "B".to_string()]);
    }

    #[test]
    fn quit_prompt_none_when_idle() {
        assert!(quit_prompt(&ActiveWork::default(), false).is_none());
        assert!(quit_prompt(
            &ActiveWork {
                count: 1,
                titles: vec!["x".into()]
            },
            true
        )
        .is_none());
    }

    #[test]
    fn quit_prompt_lists_overflow() {
        let work = ActiveWork {
            count: 6,
            titles: (1..=6).map(|i| format!("t{i}")).collect(),
        };
        let prompt = quit_prompt(&work, false).unwrap();
        assert!(prompt.message.contains("6 chats"));
        assert!(prompt.detail.contains("• 2 more"));
    }
}
