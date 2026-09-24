//! Main-window growth for in-chat onboarding (`hermesDesktop.chatOnboarding`).
//!
//! Electron SoT: `electron/window-growth.ts` + `electron/chat-onboarding-window.ts`.
//! Grows the calling window by per-edge CSS-pixel deltas (converted with zoom),
//! then recentres in the display work area — so the chat pane keeps its screen
//! rect while chrome assembles around it.

use serde::Deserialize;
use tauri::{AppHandle, Manager, PhysicalPosition, Runtime, WebviewWindow};

const MAX_DELTA_PX: f64 = 4000.0;
const MAX_WORK_AREA: f64 = 0.92;
const SOLO_BOOT_WIDTH: f64 = 600.0;
const SOLO_BOOT_HEIGHT: f64 = 640.0;

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrowRequest {
    pub bottom: Option<f64>,
    pub left: Option<f64>,
    pub min_width: Option<f64>,
    pub right: Option<f64>,
    pub top: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

fn dip(value: Option<f64>, zoom: f64, round: fn(f64) -> f64) -> f64 {
    let raw = (value.unwrap_or(0.0) * zoom).max(0.0).min(MAX_DELTA_PX);
    round(raw).max(0.0).min(MAX_DELTA_PX)
}

fn to_dip(value: Option<f64>, zoom: f64) -> f64 {
    dip(value, zoom, f64::round)
}

/// Pure geometry from Electron `growWindowBounds` — unit-tested without a window.
pub fn grow_window_bounds(
    request: &GrowRequest,
    bounds: Rect,
    work_area: Rect,
    frame_width: f64,
    zoom: f64,
) -> Rect {
    let zoom = if zoom.is_finite() && zoom > 0.0 {
        zoom
    } else {
        1.0
    };
    let frame_width = if frame_width.is_finite() && frame_width > 0.0 {
        frame_width
    } else {
        0.0
    };

    let requested_min = dip(request.min_width, zoom, f64::ceil);
    let grown = bounds.width + to_dip(request.left, zoom) + to_dip(request.right, zoom);
    let floor = if requested_min > 0.0 {
        requested_min + frame_width
    } else {
        0.0
    };
    let width = grown
        .max(floor)
        .min((work_area.width * MAX_WORK_AREA).round());

    let height = (bounds.height + to_dip(request.top, zoom) + to_dip(request.bottom, zoom))
        .min((work_area.height * MAX_WORK_AREA).round());

    centered_bounds(work_area, width, height)
}

pub fn centered_bounds(work_area: Rect, width: f64, height: f64) -> Rect {
    let width = width.max(0.0).min(work_area.width);
    let height = height.max(0.0).min(work_area.height);
    Rect {
        width,
        height,
        x: (work_area.x + (work_area.width - width) / 2.0).round(),
        y: (work_area.y + (work_area.height - height) / 2.0).round(),
    }
}

fn work_area_logical<R: Runtime>(window: &WebviewWindow<R>) -> Result<Rect, String> {
    let monitor = window
        .current_monitor()
        .map_err(|e| e.to_string())?
        .or_else(|| window.primary_monitor().ok().flatten())
        .ok_or_else(|| "no monitor for window".to_string())?;
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    Ok(Rect {
        x: f64::from(area.position.x) / scale,
        y: f64::from(area.position.y) / scale,
        width: f64::from(area.size.width) / scale,
        height: f64::from(area.size.height) / scale,
    })
}

fn outer_bounds_logical<R: Runtime>(window: &WebviewWindow<R>) -> Result<(Rect, f64), String> {
    let scale = window
        .current_monitor()
        .ok()
        .flatten()
        .map(|m| m.scale_factor())
        .unwrap_or(1.0);
    let pos = window
        .outer_position()
        .unwrap_or(PhysicalPosition::new(0, 0));
    let size = window.outer_size().map_err(|e| e.to_string())?;
    let inner = window.inner_size().unwrap_or(size);
    let bounds = Rect {
        x: f64::from(pos.x) / scale,
        y: f64::from(pos.y) / scale,
        width: f64::from(size.width) / scale,
        height: f64::from(size.height) / scale,
    };
    let frame_width = ((f64::from(size.width) - f64::from(inner.width)) / scale).max(0.0);
    Ok((bounds, frame_width))
}

fn apply_bounds<R: Runtime>(window: &WebviewWindow<R>, bounds: Rect) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    let _ = window.set_resizable(true);

    window
        .set_size(tauri::LogicalSize::new(bounds.width, bounds.height))
        .map_err(|e| format!("could not resize: {e}"))?;

    // Wayland may refuse client positioning; ignore like satellite resize.
    let _ = window.set_position(tauri::LogicalPosition::new(bounds.x, bounds.y));

    #[cfg(target_os = "linux")]
    let _ = window.set_resizable(false);

    Ok(())
}

#[cfg(desktop)]
#[tauri::command]
pub async fn chat_onboarding_grow(
    app: AppHandle,
    window: WebviewWindow,
    request: GrowRequest,
    zoom: Option<f64>,
) -> Result<(), String> {
    let label = window.label().to_string();
    let zoom = zoom.unwrap_or(1.0);
    let (tx, rx) = tokio::sync::oneshot::channel();
    let app_main = app.clone();

    app.run_on_main_thread(move || {
        let Some(window) = app_main.get_webview_window(&label) else {
            let _ = tx.send(Err("window went away".to_string()));
            return;
        };
        let result = (|| {
            let work_area = work_area_logical(&window)?;
            let (bounds, frame_width) = outer_bounds_logical(&window)?;
            let next = grow_window_bounds(&request, bounds, work_area, frame_width, zoom);
            apply_bounds(&window, next)
        })();
        let _ = tx.send(result);
    })
    .map_err(|e| format!("failed to schedule grow: {e}"))?;

    rx.await.map_err(|_| "failed to grow window".to_string())?
}

#[cfg(desktop)]
#[tauri::command]
pub async fn chat_onboarding_solo_boot(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<(), String> {
    let label = window.label().to_string();
    let (tx, rx) = tokio::sync::oneshot::channel();
    let app_main = app.clone();

    app.run_on_main_thread(move || {
        let Some(window) = app_main.get_webview_window(&label) else {
            let _ = tx.send(Err("window went away".to_string()));
            return;
        };
        let result = (|| {
            let work_area = work_area_logical(&window)?;
            let width = SOLO_BOOT_WIDTH.min(work_area.width);
            let height = SOLO_BOOT_HEIGHT.min(work_area.height);
            let next = centered_bounds(work_area, width, height);
            apply_bounds(&window, next)
        })();
        let _ = tx.send(result);
    })
    .map_err(|e| format!("failed to schedule solo boot: {e}"))?;

    rx.await
        .map_err(|_| "failed to solo-boot window".to_string())?
}

#[cfg(mobile)]
#[tauri::command]
pub async fn chat_onboarding_grow(_request: GrowRequest, _zoom: Option<f64>) -> Result<(), String> {
    Err("unsupported_platform".to_string())
}

#[cfg(mobile)]
#[tauri::command]
pub async fn chat_onboarding_solo_boot() -> Result<(), String> {
    Err("unsupported_platform".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grow_adds_edges_and_recentres() {
        let work = Rect {
            x: 0.0,
            y: 0.0,
            width: 1920.0,
            height: 1080.0,
        };
        let bounds = Rect {
            x: 100.0,
            y: 100.0,
            width: 800.0,
            height: 600.0,
        };
        let next = grow_window_bounds(
            &GrowRequest {
                left: Some(100.0),
                right: Some(100.0),
                top: Some(40.0),
                bottom: Some(40.0),
                min_width: None,
            },
            bounds,
            work,
            0.0,
            1.0,
        );
        assert_eq!(next.width, 1000.0);
        assert_eq!(next.height, 680.0);
        assert_eq!(next.x, ((1920.0_f64 - 1000.0) / 2.0).round());
        assert_eq!(next.y, ((1080.0_f64 - 680.0) / 2.0).round());
    }

    #[test]
    fn min_width_floor_uses_ceil_at_fractional_zoom() {
        // Mirror Electron: 768 CSS px @ 1.18 zoom → ceil to DIP so the media query holds.
        let work = Rect {
            x: 0.0,
            y: 0.0,
            width: 2000.0,
            height: 1200.0,
        };
        let bounds = Rect {
            x: 0.0,
            y: 0.0,
            width: 700.0,
            height: 500.0,
        };
        let next = grow_window_bounds(
            &GrowRequest {
                min_width: Some(768.0),
                left: Some(0.0),
                right: Some(0.0),
                top: Some(0.0),
                bottom: Some(0.0),
            },
            bounds,
            work,
            0.0,
            1.18,
        );
        assert!(next.width >= (768.0_f64 * 1.18).ceil());
    }

    #[test]
    fn work_area_clamp_caps_growth() {
        let work = Rect {
            x: 0.0,
            y: 0.0,
            width: 1000.0,
            height: 800.0,
        };
        let bounds = Rect {
            x: 0.0,
            y: 0.0,
            width: 900.0,
            height: 700.0,
        };
        let next = grow_window_bounds(
            &GrowRequest {
                left: Some(500.0),
                right: Some(500.0),
                top: Some(500.0),
                bottom: Some(500.0),
                min_width: None,
            },
            bounds,
            work,
            0.0,
            1.0,
        );
        assert_eq!(next.width, (1000.0 * MAX_WORK_AREA).round());
        assert_eq!(next.height, (800.0 * MAX_WORK_AREA).round());
    }

    #[test]
    fn solo_boot_size_fits_small_displays() {
        let work = Rect {
            x: 10.0,
            y: 20.0,
            width: 500.0,
            height: 400.0,
        };
        let next = centered_bounds(
            work,
            SOLO_BOOT_WIDTH.min(work.width),
            SOLO_BOOT_HEIGHT.min(work.height),
        );
        assert_eq!(next.width, 500.0);
        assert_eq!(next.height, 400.0);
        assert_eq!(next.x, 10.0);
        assert_eq!(next.y, 20.0);
    }
}
