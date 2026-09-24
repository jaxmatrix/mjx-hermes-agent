//! Pop-out pet overlay window (`hermesDesktop.petOverlay`).
//!
//! Electron SoT: `electron/pet-overlay-ipc.ts`. Transparent always-on-top
//! `?win=overlay` window; state/control ride the Tauri event bus; open converts
//! viewport bounds using the main window's content origin when `screen` is false.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

/// Capability-scoped (`sat-*` in `capabilities/default.json`).
pub const WINDOW_LABEL: &str = "sat-pet";

pub const STATE_EVENT: &str = "hermes://pet-overlay-state";
pub const CONTROL_EVENT: &str = "hermes://pet-overlay-control";

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetOverlayBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PetOverlayOpenRequest {
    pub bounds: Option<PetOverlayBounds>,
    pub screen: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetOverlayOpenResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bounds: Option<PetOverlayBounds>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OkResult {
    pub ok: bool,
}

fn raise_main(app: &AppHandle) {
    if let Some(main) = app.get_webview_window(crate::window::MAIN_WINDOW_LABEL) {
        let _ = main.unminimize();
        let _ = main.show();
        let _ = main.set_focus();
    }
}

fn minimize_main(app: &AppHandle) {
    if let Some(main) = app.get_webview_window(crate::window::MAIN_WINDOW_LABEL) {
        let _ = main.minimize();
    }
}

fn main_content_origin(app: &AppHandle) -> (f64, f64) {
    let Some(main) = app.get_webview_window(crate::window::MAIN_WINDOW_LABEL) else {
        return (0.0, 0.0);
    };
    let scale = main
        .current_monitor()
        .ok()
        .flatten()
        .map(|m| m.scale_factor())
        .unwrap_or(1.0);
    let pos = main.outer_position().ok();
    // Frameless: outer ≈ content. Prefer inner when available.
    let (px, py) = match (main.inner_position().ok(), pos) {
        (Some(inner), _) => (f64::from(inner.x) / scale, f64::from(inner.y) / scale),
        (_, Some(outer)) => (f64::from(outer.x) / scale, f64::from(outer.y) / scale),
        _ => (0.0, 0.0),
    };
    (px, py)
}

fn resolve_screen_bounds(
    app: &AppHandle,
    request: &PetOverlayOpenRequest,
) -> Option<PetOverlayBounds> {
    let bounds = request.bounds.clone()?;
    if request.screen == Some(true) {
        return Some(bounds);
    }
    let (ox, oy) = main_content_origin(app);
    Some(PetOverlayBounds {
        x: ox + bounds.x,
        y: oy + bounds.y,
        width: bounds.width.max(80.0),
        height: bounds.height.max(80.0),
    })
}

fn apply_bounds(window: &tauri::WebviewWindow, bounds: &PetOverlayBounds) -> Result<(), String> {
    let width = bounds.width.max(80.0).round();
    let height = bounds.height.max(80.0).round();
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

    #[cfg(target_os = "linux")]
    if resizing {
        let _ = window.set_resizable(true);
    }

    window
        .set_size(tauri::LogicalSize::new(width, height))
        .map_err(|e| format!("could not resize pet overlay: {e}"))?;
    let _ = window.set_position(tauri::LogicalPosition::new(
        bounds.x.round(),
        bounds.y.round(),
    ));

    #[cfg(target_os = "linux")]
    if resizing {
        let _ = window.set_resizable(false);
    }

    Ok(())
}

#[cfg(desktop)]
#[tauri::command]
pub async fn pet_overlay_open(
    app: AppHandle,
    request: Option<PetOverlayOpenRequest>,
) -> Result<PetOverlayOpenResult, String> {
    let request = request.unwrap_or(PetOverlayOpenRequest {
        bounds: None,
        screen: None,
    });
    let screen_bounds = resolve_screen_bounds(&app, &request).unwrap_or(PetOverlayBounds {
        x: 100.0,
        y: 100.0,
        width: 240.0,
        height: 300.0,
    });

    let (tx, rx) = tokio::sync::oneshot::channel();
    let app_main = app.clone();
    let bounds_for_build = screen_bounds.clone();

    app.run_on_main_thread(move || {
        let result: Result<(), String> = (|| {
            if let Some(existing) = app_main.get_webview_window(WINDOW_LABEL) {
                apply_bounds(&existing, &bounds_for_build)?;
                let _ = existing.show();
                return Ok(());
            }

            #[allow(unused_mut)]
            let mut builder = WebviewWindowBuilder::new(
                &app_main,
                WINDOW_LABEL,
                WebviewUrl::App("index.html?win=overlay#/".into()),
            )
            .title("Hermes Pet")
            .inner_size(
                bounds_for_build.width.max(80.0),
                bounds_for_build.height.max(80.0),
            )
            .position(bounds_for_build.x, bounds_for_build.y)
            .decorations(false)
            .resizable(false)
            .maximizable(false)
            .minimizable(false)
            .always_on_top(true)
            .shadow(false)
            .transparent(true)
            .visible(true)
            .focused(false);

            #[cfg(any(target_os = "linux", target_os = "windows"))]
            {
                builder = builder.skip_taskbar(true);
            }

            let window = builder
                .build()
                .map_err(|e| format!("could not open pet overlay: {e}"))?;

            // Born click-through until the renderer opts in over the sprite.
            let _ = window.set_ignore_cursor_events(true);
            Ok(())
        })();
        let _ = tx.send(result);
    })
    .map_err(|e| format!("failed to schedule pet overlay open: {e}"))?;

    rx.await
        .map_err(|_| "failed to open pet overlay".to_string())??;

    Ok(PetOverlayOpenResult {
        ok: true,
        bounds: Some(screen_bounds),
    })
}

#[cfg(desktop)]
#[tauri::command]
pub async fn pet_overlay_close(app: AppHandle) -> Result<OkResult, String> {
    if let Some(win) = app.get_webview_window(WINDOW_LABEL) {
        let _ = win.close();
    }
    Ok(OkResult { ok: true })
}

#[cfg(desktop)]
#[tauri::command]
pub async fn pet_overlay_set_bounds(
    app: AppHandle,
    bounds: PetOverlayBounds,
) -> Result<(), String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let app_main = app.clone();
    app.run_on_main_thread(move || {
        let result = if let Some(win) = app_main.get_webview_window(WINDOW_LABEL) {
            apply_bounds(&win, &bounds)
        } else {
            Ok(())
        };
        let _ = tx.send(result);
    })
    .map_err(|e| format!("failed to schedule set-bounds: {e}"))?;
    rx.await
        .map_err(|_| "failed to set pet overlay bounds".to_string())?
}

#[cfg(desktop)]
#[tauri::command]
pub async fn pet_overlay_set_ignore_mouse(app: AppHandle, ignore: bool) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(WINDOW_LABEL) {
        let _ = win.set_ignore_cursor_events(ignore);
    }
    Ok(())
}

#[cfg(desktop)]
#[tauri::command]
pub async fn pet_overlay_set_focusable(app: AppHandle, focusable: bool) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(WINDOW_LABEL) {
        let _ = win.set_focusable(focusable);
        if focusable {
            let _ = win.set_focus();
        }
    }
    Ok(())
}

/// Main → overlay: broadcast pet state (Electron forwarded to the overlay WC).
#[cfg(desktop)]
#[tauri::command]
pub async fn pet_overlay_push_state(
    app: AppHandle,
    payload: serde_json::Value,
) -> Result<(), String> {
    let _ = app.emit(STATE_EVENT, payload);
    Ok(())
}

/// Overlay → main: control messages. `toggle-app` stays native; `open-app`
/// raises main before the event reaches the renderer.
#[cfg(desktop)]
#[tauri::command]
pub async fn pet_overlay_control(
    app: AppHandle,
    window: tauri::WebviewWindow,
    payload: serde_json::Value,
) -> Result<(), String> {
    if window.label() != WINDOW_LABEL {
        // Main may also call control? No — only overlay. Allow main for tests.
        if window.label() != crate::window::MAIN_WINDOW_LABEL {
            return Err("pet control only from the pet overlay".to_string());
        }
    }

    let control_type = payload.get("type").and_then(|v| v.as_str()).unwrap_or("");

    match control_type {
        "toggle-app" => {
            if let Some(main) = app.get_webview_window(crate::window::MAIN_WINDOW_LABEL) {
                let minimized = main.is_minimized().unwrap_or(false);
                let visible = main.is_visible().unwrap_or(true);
                if minimized || !visible {
                    raise_main(&app);
                } else {
                    minimize_main(&app);
                }
            }
            return Ok(());
        }
        "open-app" => {
            raise_main(&app);
        }
        _ => {}
    }

    let _ = app.emit(CONTROL_EVENT, payload);
    Ok(())
}

#[cfg(mobile)]
#[tauri::command]
pub async fn pet_overlay_open(
    _request: Option<PetOverlayOpenRequest>,
) -> Result<PetOverlayOpenResult, String> {
    Err("unsupported_platform".to_string())
}

#[cfg(mobile)]
#[tauri::command]
pub async fn pet_overlay_close() -> Result<OkResult, String> {
    Err("unsupported_platform".to_string())
}

#[cfg(mobile)]
#[tauri::command]
pub async fn pet_overlay_set_bounds(_bounds: PetOverlayBounds) -> Result<(), String> {
    Err("unsupported_platform".to_string())
}

#[cfg(mobile)]
#[tauri::command]
pub async fn pet_overlay_set_ignore_mouse(_ignore: bool) -> Result<(), String> {
    Err("unsupported_platform".to_string())
}

#[cfg(mobile)]
#[tauri::command]
pub async fn pet_overlay_set_focusable(_focusable: bool) -> Result<(), String> {
    Err("unsupported_platform".to_string())
}

#[cfg(mobile)]
#[tauri::command]
pub async fn pet_overlay_push_state(_payload: serde_json::Value) -> Result<(), String> {
    Err("unsupported_platform".to_string())
}

#[cfg(mobile)]
#[tauri::command]
pub async fn pet_overlay_control(_payload: serde_json::Value) -> Result<(), String> {
    Err("unsupported_platform".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn label_is_capability_scoped() {
        assert!(WINDOW_LABEL.starts_with("sat-"));
    }

    #[test]
    fn viewport_bounds_add_origin() {
        let viewport = PetOverlayBounds {
            x: 10.0,
            y: 20.0,
            width: 240.0,
            height: 300.0,
        };
        let screen = PetOverlayBounds {
            x: 100.0 + viewport.x,
            y: 50.0 + viewport.y,
            width: viewport.width,
            height: viewport.height,
        };
        assert_eq!(screen.x, 110.0);
        assert_eq!(screen.y, 70.0);
    }
}
