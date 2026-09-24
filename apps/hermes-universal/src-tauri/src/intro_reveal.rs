//! First-run intro film overlay (`hermesDesktop.introReveal`).
//!
//! Electron SoT: `electron/intro-reveal-window.ts`. Full-screen transparent
//! `?win=intro` window; main hides while it plays; `ready` reveals after paint;
//! skip/close restore main and notify the main renderer.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

/// Longer than the renderer's INTRO_DEADMAN_MS so a stalled clock still closes.
pub const INTRO_REVEAL_WATCHDOG_MS: u64 = 34_000;
const INTRO_CLOSE_DELAY_MS: u64 = 600;

/// Capability-scoped label (`sat-*` in `capabilities/default.json`).
pub const WINDOW_LABEL: &str = "sat-intro";

pub const SKIP_EVENT: &str = "hermes://intro-reveal-skip";
pub const CLOSED_EVENT: &str = "hermes://intro-reveal-closed";

#[derive(Debug, Default)]
pub struct IntroRevealState {
    hid_main: AtomicBool,
    /// Generation so a late watchdog from a prior film cannot close a new one.
    generation: Mutex<u64>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntroRevealOpenPayload {
    pub hide_main: Option<bool>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntroRevealClosePayload {
    pub show_main: Option<bool>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OkResult {
    pub ok: bool,
}

fn show_main(app: &AppHandle) {
    if let Some(main) = app.get_webview_window(crate::window::MAIN_WINDOW_LABEL) {
        let _ = main.unminimize();
        let _ = main.show();
        let _ = main.set_focus();
    }
}

fn hide_main(app: &AppHandle) {
    if let Some(main) = app.get_webview_window(crate::window::MAIN_WINDOW_LABEL) {
        let _ = main.hide();
    }
}

fn arm_watchdog(app: AppHandle, generation: u64) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(INTRO_REVEAL_WATCHDOG_MS)).await;
        let Some(state) = app.try_state::<IntroRevealState>() else {
            return;
        };
        let current = state.generation.lock().map(|g| *g).unwrap_or(0);
        if current != generation {
            return;
        }
        let _ = close_intro_reveal_inner(
            &app,
            &state,
            IntroRevealClosePayload {
                show_main: Some(true),
            },
        )
        .await;
    });
}

fn bump_generation(state: &IntroRevealState) -> u64 {
    let mut gen = state.generation.lock().expect("intro generation lock");
    *gen = gen.wrapping_add(1);
    *gen
}

fn invalidate_generation(state: &IntroRevealState) {
    let _ = bump_generation(state);
}

async fn close_intro_reveal_inner(
    app: &AppHandle,
    state: &IntroRevealState,
    payload: IntroRevealClosePayload,
) -> Result<OkResult, String> {
    invalidate_generation(state);

    let show = payload.show_main.unwrap_or(false);
    let hid = state.hid_main.load(Ordering::SeqCst);

    if app.get_webview_window(WINDOW_LABEL).is_some() {
        let app_close = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(INTRO_CLOSE_DELAY_MS)).await;
            if let Some(win) = app_close.get_webview_window(WINDOW_LABEL) {
                let _ = win.close();
            }
        });
    }

    if show && hid {
        state.hid_main.store(false, Ordering::SeqCst);
        show_main(app);
    }

    Ok(OkResult { ok: true })
}

/// Called from `RunEvent::Destroyed` so a native teardown still restores main
/// and notifies the main renderer (Electron `closed` handler).
pub fn on_destroyed(app: &AppHandle, state: &IntroRevealState) {
    invalidate_generation(state);
    if state.hid_main.swap(false, Ordering::SeqCst) {
        show_main(app);
    }
    let _ = app.emit(CLOSED_EVENT, ());
}

#[cfg(desktop)]
#[tauri::command]
pub async fn intro_reveal_open(
    app: AppHandle,
    state: State<'_, IntroRevealState>,
    payload: Option<IntroRevealOpenPayload>,
) -> Result<OkResult, String> {
    let payload = payload.unwrap_or_default();

    if app.get_webview_window(WINDOW_LABEL).is_some() {
        return Ok(OkResult { ok: true });
    }

    let generation = bump_generation(&state);
    let (tx, rx) = tokio::sync::oneshot::channel();
    let app_main = app.clone();

    app.run_on_main_thread(move || {
        let result: Result<(), String> = (|| {
            let monitor = app_main
                .primary_monitor()
                .map_err(|e| e.to_string())?
                .ok_or_else(|| "no primary monitor".to_string())?;
            let scale = monitor.scale_factor();
            let size = monitor.size();
            let pos = monitor.position();
            let width = f64::from(size.width) / scale;
            let height = f64::from(size.height) / scale;
            let x = f64::from(pos.x) / scale;
            let y = f64::from(pos.y) / scale;

            #[allow(unused_mut)]
            let mut builder = WebviewWindowBuilder::new(
                &app_main,
                WINDOW_LABEL,
                WebviewUrl::App("index.html?win=intro#/".into()),
            )
            .title("Hermes")
            .inner_size(width, height)
            .position(x, y)
            .decorations(false)
            .resizable(false)
            .maximizable(false)
            .minimizable(false)
            .always_on_top(true)
            .shadow(false)
            .transparent(true)
            .visible(false)
            .focused(true);

            #[cfg(any(target_os = "linux", target_os = "windows"))]
            {
                builder = builder.skip_taskbar(true);
            }

            builder
                .build()
                .map_err(|e| format!("could not open intro reveal: {e}"))?;
            Ok(())
        })();
        let _ = tx.send(result);
    })
    .map_err(|e| format!("failed to schedule intro open: {e}"))?;

    rx.await
        .map_err(|_| "failed to open intro reveal".to_string())??;

    if payload.hide_main == Some(true) {
        state.hid_main.store(true, Ordering::SeqCst);
        hide_main(&app);
    }

    arm_watchdog(app.clone(), generation);
    Ok(OkResult { ok: true })
}

#[cfg(desktop)]
#[tauri::command]
pub async fn intro_reveal_close(
    app: AppHandle,
    state: State<'_, IntroRevealState>,
    payload: Option<IntroRevealClosePayload>,
) -> Result<OkResult, String> {
    close_intro_reveal_inner(&app, &state, payload.unwrap_or_default()).await
}

#[cfg(desktop)]
#[tauri::command]
pub async fn intro_reveal_ready(
    app: AppHandle,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    if window.label() != WINDOW_LABEL {
        return Err("intro ready only from the intro window".to_string());
    }
    let _ = window.show();
    let _ = window.set_focus();
    let _ = app;
    Ok(())
}

#[cfg(desktop)]
#[tauri::command]
pub async fn intro_reveal_skip(app: AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != WINDOW_LABEL {
        return Err("intro skip only from the intro window".to_string());
    }
    let _ = app.emit(SKIP_EVENT, ());
    Ok(())
}

#[cfg(mobile)]
#[tauri::command]
pub async fn intro_reveal_open(
    _payload: Option<IntroRevealOpenPayload>,
) -> Result<OkResult, String> {
    Err("unsupported_platform".to_string())
}

#[cfg(mobile)]
#[tauri::command]
pub async fn intro_reveal_close(
    _payload: Option<IntroRevealClosePayload>,
) -> Result<OkResult, String> {
    Err("unsupported_platform".to_string())
}

#[cfg(mobile)]
#[tauri::command]
pub async fn intro_reveal_ready() -> Result<(), String> {
    Err("unsupported_platform".to_string())
}

#[cfg(mobile)]
#[tauri::command]
pub async fn intro_reveal_skip() -> Result<(), String> {
    Err("unsupported_platform".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn label_is_capability_scoped_satellite() {
        assert!(WINDOW_LABEL.starts_with("sat-"));
        assert_eq!(WINDOW_LABEL, "sat-intro");
    }

    #[test]
    fn watchdog_outlives_renderer_deadman() {
        // Electron comment: longer than INTRO_DEADMAN_MS (~30s).
        assert!(INTRO_REVEAL_WATCHDOG_MS > 30_000);
    }
}
