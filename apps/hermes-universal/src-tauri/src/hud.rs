//! HUD satellite window ops (`hermesDesktop.hud`).
//!
//! Electron SoT: `electron/hud-ipc.ts` + `hud-windowing.ts` (+ drag bits in
//! `hud-drag.ts`). Open/close ride `open_satellite_window` /
//! `hide_satellite_window`; this module owns ignore-mouse, bounds, renderer
//! drag, reset-layout, session handoff, and `hermes://hud-*` events.
//! Frost (`setFrost`) is applied from the bridge via `appearance_set_glass` on
//! the calling HUD webview — same injected-window rule as translucency.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

/// Capability-scoped (`sat-*` in `capabilities/default.json`).
pub const WINDOW_LABEL: &str = "sat-hud";

pub const CHANGED_EVENT: &str = "hermes://hud-changed";
pub const GOTO_EVENT: &str = "hermes://hud-goto";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HudBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OkResult {
    pub ok: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HudChanged {
    pub open: bool,
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HudWindowingView {
    pub client_placement: bool,
    pub control_drag: bool,
    pub native_drag: bool,
    pub solid: bool,
    pub workspace_transfer: bool,
}

#[derive(Default)]
pub struct HudState {
    inner: Mutex<HudInner>,
}

#[derive(Default)]
struct HudInner {
    /// Session the HUD last reported — handed back on close for re-home.
    session_id: Option<String>,
    /// Renderer-drag grab: cursor origin + window origin at begin_move.
    drag: Option<DragLatch>,
}

#[derive(Clone, Copy)]
struct DragLatch {
    cursor_x: f64,
    cursor_y: f64,
    win_x: f64,
    win_y: f64,
}

fn hud_window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    app.get_webview_window(WINDOW_LABEL)
}

fn emit_changed(app: &AppHandle, open: bool, session_id: Option<String>) {
    let _ = app.emit(CHANGED_EVENT, HudChanged { open, session_id });
}

/// Broadcast after TS open/close (or when hide_satellite tears the HUD down).
#[tauri::command]
pub async fn hud_broadcast_changed(
    app: AppHandle,
    state: State<'_, HudState>,
    open: bool,
) -> Result<(), String> {
    let session_id = state
        .inner
        .lock()
        .map(|g| g.session_id.clone())
        .unwrap_or(None);
    if !open {
        if let Ok(mut g) = state.inner.lock() {
            g.session_id = None;
            g.drag = None;
        }
    }
    emit_changed(&app, open, session_id);
    Ok(())
}

#[tauri::command]
pub async fn hud_set_session(
    state: State<'_, HudState>,
    session_id: Option<String>,
) -> Result<(), String> {
    let next = session_id
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    if let Ok(mut g) = state.inner.lock() {
        g.session_id = next;
    }
    Ok(())
}

#[tauri::command]
pub async fn hud_set_ignore_mouse(app: AppHandle, ignore: bool) -> Result<(), String> {
    let Some(win) = hud_window(&app) else {
        return Ok(());
    };
    // Mirror Electron's X11 veto: when the windowing profile is solid, ignore
    // is a one-way door on that backend. Callers still get a no-op rather than
    // an error so the click-through hook stays quiet.
    #[cfg(all(desktop, target_os = "linux"))]
    {
        let solid = hud_windowing_view().solid;
        if ignore && solid {
            return Ok(());
        }
    }
    let _ = win.set_ignore_cursor_events(ignore);
    Ok(())
}

#[tauri::command]
pub async fn hud_set_bounds(app: AppHandle, bounds: HudBounds) -> Result<(), String> {
    let Some(win) = hud_window(&app) else {
        return Ok(());
    };
    apply_bounds(&win, &bounds)
}

fn apply_bounds(window: &tauri::WebviewWindow, bounds: &HudBounds) -> Result<(), String> {
    let width = bounds.width.max(80.0).round();
    let height = bounds.height.max(48.0).round();
    let resizing = window
        .outer_size()
        .ok()
        .map(|s| {
            let scale = window
                .current_monitor()
                .ok()
                .flatten()
                .map(|m| m.scale_factor())
                .unwrap_or(1.0);
            (f64::from(s.width) / scale - width).abs() > 0.5
                || (f64::from(s.height) / scale - height).abs() > 0.5
        })
        .unwrap_or(true);

    #[cfg(any(target_os = "linux", target_os = "windows"))]
    let restore_lock = resizing && !window.is_resizable().unwrap_or(false);
    #[cfg(any(target_os = "linux", target_os = "windows"))]
    if restore_lock {
        let _ = window.set_resizable(true);
    }

    window
        .set_size(tauri::LogicalSize::new(width, height))
        .map_err(|e| format!("could not resize HUD: {e}"))?;
    let _ = window.set_position(tauri::LogicalPosition::new(
        bounds.x.round(),
        bounds.y.round(),
    ));

    #[cfg(any(target_os = "linux", target_os = "windows"))]
    if restore_lock {
        let _ = window.set_resizable(false);
    }

    Ok(())
}

#[tauri::command]
pub async fn hud_begin_move(app: AppHandle, state: State<'_, HudState>) -> Result<(), String> {
    let Some(win) = hud_window(&app) else {
        return Ok(());
    };
    if !hud_windowing_view().client_placement {
        return Ok(());
    }
    let scale = win
        .current_monitor()
        .ok()
        .flatten()
        .map(|m| m.scale_factor())
        .unwrap_or(1.0);
    let cursor = win.cursor_position().map_err(|e| format!("cursor: {e}"))?;
    let pos = win.outer_position().map_err(|e| format!("position: {e}"))?;
    if let Ok(mut g) = state.inner.lock() {
        g.drag = Some(DragLatch {
            cursor_x: f64::from(cursor.x) / scale,
            cursor_y: f64::from(cursor.y) / scale,
            win_x: f64::from(pos.x) / scale,
            win_y: f64::from(pos.y) / scale,
        });
    }
    Ok(())
}

#[tauri::command]
pub async fn hud_end_move(state: State<'_, HudState>) -> Result<(), String> {
    if let Ok(mut g) = state.inner.lock() {
        g.drag = None;
    }
    Ok(())
}

#[tauri::command]
pub async fn hud_move_by(
    app: AppHandle,
    state: State<'_, HudState>,
    delta: HudBounds,
) -> Result<(), String> {
    let Some(win) = hud_window(&app) else {
        return Ok(());
    };
    if !hud_windowing_view().client_placement {
        return Ok(());
    }
    let latch = state
        .inner
        .lock()
        .ok()
        .and_then(|g| g.drag)
        .ok_or_else(|| "no drag in progress".to_string())?;
    let scale = win
        .current_monitor()
        .ok()
        .flatten()
        .map(|m| m.scale_factor())
        .unwrap_or(1.0);
    let cursor = win.cursor_position().map_err(|e| format!("cursor: {e}"))?;
    let cx = f64::from(cursor.x) / scale;
    let cy = f64::from(cursor.y) / scale;
    let x = latch.win_x + (cx - latch.cursor_x);
    let y = latch.win_y + (cy - latch.cursor_y);
    apply_bounds(
        &win,
        &HudBounds {
            x,
            y,
            width: delta.width,
            height: delta.height,
        },
    )
}

#[tauri::command]
pub async fn hud_set_workspace_transfer(transferring: bool) -> Result<(), String> {
    let _ = transferring;
    // Electron X11/KWin all-workspaces during a grab. No Tauri analogue yet —
    // soft no-op so the composer-drag path stays quiet.
    Ok(())
}

#[tauri::command]
pub async fn hud_reset_layout(app: AppHandle) -> Result<OkResult, String> {
    let Some(win) = hud_window(&app) else {
        return Ok(OkResult { ok: false });
    };
    let monitor = win
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| win.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        return Ok(OkResult { ok: false });
    };
    let scale = monitor.scale_factor();
    let size = monitor.size();
    let pos = monitor.position();
    // Match window.rs HUD defaults: 600×80, ~96px from the top, centred.
    let width = 600.0_f64;
    let height = 80.0_f64;
    let work_w = f64::from(size.width) / scale;
    let work_x = f64::from(pos.x) / scale;
    let work_y = f64::from(pos.y) / scale;
    let x = work_x + ((work_w - width) / 2.0).max(0.0);
    let y = work_y + 96.0;
    apply_bounds(
        &win,
        &HudBounds {
            x,
            y,
            width,
            height,
        },
    )?;
    Ok(OkResult { ok: true })
}

#[tauri::command]
pub fn hud_windowing() -> HudWindowingView {
    hud_windowing_view()
}

/// Electron `resolveHudWindowing` / `hudWindowingView` — Tauri has no Ozone
/// switch, so Linux follows the session: Wayland → native-drag + click-through;
/// X11 → solid + renderer-drag + client placement.
fn hud_windowing_view() -> HudWindowingView {
    #[cfg(target_os = "macos")]
    {
        return HudWindowingView {
            client_placement: true,
            control_drag: false,
            native_drag: false,
            solid: false,
            workspace_transfer: false,
        };
    }
    #[cfg(target_os = "windows")]
    {
        return HudWindowingView {
            client_placement: true,
            control_drag: false,
            native_drag: false,
            solid: false,
            workspace_transfer: false,
        };
    }
    #[cfg(target_os = "linux")]
    {
        let wayland = std::env::var_os("WAYLAND_DISPLAY").is_some()
            && std::env::var("XDG_SESSION_TYPE")
                .map(|s| s.eq_ignore_ascii_case("wayland"))
                .unwrap_or(true);
        return HudWindowingView {
            client_placement: !wayland,
            control_drag: !wayland,
            native_drag: wayland,
            solid: !wayland,
            workspace_transfer: !wayland,
        };
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        HudWindowingView {
            client_placement: false,
            control_drag: false,
            native_drag: false,
            solid: true,
            workspace_transfer: false,
        }
    }
}

/// Emit goto so an already-open HUD retargets (Electron `hermes:hud:goto`).
#[tauri::command]
pub async fn hud_emit_goto(app: AppHandle, session_id: String) -> Result<(), String> {
    let id = session_id.trim();
    if id.is_empty() {
        return Ok(());
    }
    let _ = app.emit(GOTO_EVENT, id.to_string());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windowing_view_is_total() {
        let v = hud_windowing_view();
        // Booleans only — just ensure the function returns on this host.
        let _ =
            v.client_placement | v.control_drag | v.native_drag | v.solid | v.workspace_transfer;
    }
}
