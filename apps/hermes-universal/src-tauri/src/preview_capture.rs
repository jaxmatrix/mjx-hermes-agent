//! Preview guest capture — Electron `preview-capture.ts`.
//!
//! Captures the in-app browser guest's on-screen region (Tauri has no
//! `webContents.capturePage`), then crops in bitmap space from CSS viewport
//! coordinates — same geometry contract as Electron.

use std::io::Cursor;

use base64::Engine as _;
use serde::Deserialize;
use tauri::{AppHandle, State};

use crate::browser::{BrowserState, BROWSER_GUEST_ID};

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureViewport {
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Copy, Debug)]
pub struct IntRect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

pub fn normalize_capture_rect(rect: Option<CaptureRect>) -> Option<IntRect> {
    let rect = rect?;
    Some(IntRect {
        x: rect.x.max(0.0).floor() as u32,
        y: rect.y.max(0.0).floor() as u32,
        width: rect.width.max(1.0).ceil() as u32,
        height: rect.height.max(1.0).ceil() as u32,
    })
}

/// Map a CSS-pixel viewport rect onto a (possibly DPR-scaled) bitmap.
pub fn map_viewport_rect_to_image(
    rect: IntRect,
    viewport: CaptureViewport,
    image: CaptureViewport,
) -> Option<IntRect> {
    let view_w = viewport.width.max(1.0);
    let view_h = viewport.height.max(1.0);
    let scale_x = image.width / view_w;
    let scale_y = image.height / view_h;
    let left = rect.x as f64 * scale_x;
    let top = rect.y as f64 * scale_y;
    let right = (rect.x as f64 + rect.width as f64) * scale_x;
    let bottom = (rect.y as f64 + rect.height as f64) * scale_y;
    let x = left.max(0.0).floor() as u32;
    let y = top.max(0.0).floor() as u32;
    let max_x = right.min(image.width).ceil() as u32;
    let max_y = bottom.min(image.height).ceil() as u32;
    let width = max_x.saturating_sub(x);
    let height = max_y.saturating_sub(y);
    if width < 1 || height < 1 {
        return None;
    }
    Some(IntRect {
        x,
        y,
        width,
        height,
    })
}

fn rgba_to_png_data_url(rgba: &[u8], width: u32, height: u32) -> Result<String, String> {
    let expected = (width as usize)
        .checked_mul(height as usize)
        .and_then(|n| n.checked_mul(4))
        .ok_or_else(|| "preview capture: dimensions overflow".to_string())?;
    if rgba.len() < expected {
        return Err("preview capture was empty".into());
    }
    let img = image::RgbaImage::from_raw(width, height, rgba[..expected].to_vec())
        .ok_or_else(|| "preview capture was empty".to_string())?;
    let mut out = Cursor::new(Vec::new());
    img.write_to(&mut out, image::ImageFormat::Png)
        .map_err(|e| format!("preview capture encode failed: {e}"))?;
    Ok(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(out.into_inner())
    ))
}

fn crop_rgba(
    rgba: &[u8],
    full_w: u32,
    full_h: u32,
    crop: IntRect,
) -> Result<(Vec<u8>, u32, u32), String> {
    let img = image::RgbaImage::from_raw(full_w, full_h, rgba.to_vec())
        .ok_or_else(|| "preview capture was empty".to_string())?;
    if crop.x + crop.width > full_w || crop.y + crop.height > full_h {
        return Err("preview capture crop out of bounds".into());
    }
    let cropped =
        image::imageops::crop_imm(&img, crop.x, crop.y, crop.width, crop.height).to_image();
    Ok((cropped.into_raw(), crop.width, crop.height))
}

/// Capture the guest webview's on-screen pixels via `xcap`, then optionally crop.
#[tauri::command]
pub async fn capture_preview(
    app: AppHandle,
    state: State<'_, BrowserState>,
    rect: Option<CaptureRect>,
    viewport: Option<CaptureViewport>,
    #[allow(unused_variables)] web_contents_id: Option<i64>,
    guest_id: Option<String>,
) -> Result<String, String> {
    let id = guest_id.unwrap_or_else(|| BROWSER_GUEST_ID.to_string());

    let (rgba, width, height) = state
        .capture_guest_rgba(&id)
        .await
        .map_err(|e| e.to_string())?;

    if width == 0 || height == 0 || rgba.is_empty() {
        return Err("preview capture was empty".into());
    }

    let crop = normalize_capture_rect(rect);
    let Some(crop) = crop else {
        return rgba_to_png_data_url(&rgba, width, height);
    };

    let image_vp = CaptureViewport {
        width: width as f64,
        height: height as f64,
    };
    let view = match viewport {
        Some(v) if v.width > 0.0 && v.height > 0.0 => v,
        _ => image_vp,
    };

    if let Some(mapped) = map_viewport_rect_to_image(crop, view, image_vp) {
        if let Ok((bytes, w, h)) = crop_rgba(&rgba, width, height, mapped) {
            if !bytes.is_empty() {
                return rgba_to_png_data_url(&bytes, w, h);
            }
        }
    }

    // Off-screen CSS rects: fall back to the visible page (Electron contract).
    let _ = app;
    rgba_to_png_data_url(&rgba, width, height)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_floors_and_ceils() {
        let r = normalize_capture_rect(Some(CaptureRect {
            x: 1.2,
            y: -3.0,
            width: 0.4,
            height: 2.1,
        }))
        .unwrap();
        assert_eq!(r.x, 1);
        assert_eq!(r.y, 0);
        assert_eq!(r.width, 1);
        assert_eq!(r.height, 3);
    }

    #[test]
    fn map_scales_dpr() {
        let mapped = map_viewport_rect_to_image(
            IntRect {
                x: 10,
                y: 20,
                width: 100,
                height: 50,
            },
            CaptureViewport {
                width: 200.0,
                height: 100.0,
            },
            CaptureViewport {
                width: 400.0,
                height: 200.0,
            },
        )
        .unwrap();
        assert_eq!(mapped.x, 20);
        assert_eq!(mapped.y, 40);
        assert_eq!(mapped.width, 200);
        assert_eq!(mapped.height, 100);
    }
}
