//! Native appearance surfaces (desktop): window translucency.
//!
//! Translucency mirrors the desktop's single 0-100 lever mapped to whole-window
//! opacity (`opacity = 1 - intensity/100 * 0.7`). Linux uses the GTK toplevel's
//! opacity (works with a compositor — unlike Electron, which no-ops on Linux).
//! macOS/Windows would set the native window alpha; left as a follow-up (can't be
//! verified from this host) so those builds keep a safe no-op.

/// Apply whole-window translucency from a 0-100 intensity.
#[cfg(desktop)]
#[tauri::command]
pub fn set_window_translucency(window: tauri::Window, intensity: u8) -> Result<(), String> {
    let clamped = f64::from(intensity.min(100));
    let opacity = 1.0 - (clamped / 100.0) * 0.7;

    #[cfg(target_os = "linux")]
    {
        use gtk::prelude::WidgetExt;
        let gtk_win = window.gtk_window().map_err(|e| e.to_string())?;
        gtk_win.set_opacity(opacity);
    }
    #[cfg(not(target_os = "linux"))]
    {
        // TODO(appearance): macOS NSWindow alphaValue / Windows layered-window alpha.
        let _ = (&window, opacity);
    }

    Ok(())
}

#[cfg(mobile)]
#[tauri::command]
pub async fn set_window_translucency(_intensity: u8) -> Result<(), String> {
    Err("unsupported_platform".to_string())
}
