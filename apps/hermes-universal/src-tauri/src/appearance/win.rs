//! Windows glass backend: DWM system backdrops + layered-window alpha.
//!
//! `window-vibrancy` is called directly rather than through Tauri's
//! `Window::set_effects`, which discards the crate's `Result` (see the module
//! header). On build ≥ 22621 all three backdrops go through
//! `DWMWA_SYSTEMBACKDROP_TYPE`, so applying one replaces whatever the window
//! carried and a single `clear_acrylic` (`DWMSBT_DISABLE`) turns them all off.
//!
//! The build floor is enforced HERE as well as in the capability report,
//! because the crate will happily try below it — acrylic via the undocumented
//! `SetWindowCompositionAttribute` from 17763, mica via an undocumented
//! attribute from 22000 — and `tabbed` does not exist below 22523 at all, so a
//! Windows 10 user would get a picker whose rungs composite identically.

use windows_sys::Win32::Foundation::HWND;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetWindowLongPtrW, SetLayeredWindowAttributes, SetWindowLongPtrW, GWL_EXSTYLE, LWA_ALPHA,
    WS_EX_LAYERED,
};

use super::model::{
    backdrop_for, distinct_backdrop_rungs, glass_active, glass_supported_for, window_opacity_for,
    Changed, FrostRung, GlassRequest, WindowsBackdrop, WINDOWS_GLASS_MIN_BUILD,
};
use super::{GlassOutcome, GlassStep};
use crate::surface::Support;

/// The Windows build number, or `None` when the OS will not say — which fails
/// closed, exactly as the TS side's `release.split('.')[2]` parse does.
fn os_build() -> Option<u32> {
    match tauri_plugin_os::version() {
        tauri_plugin_os::Version::Semantic(_, _, build) => u32::try_from(build).ok(),
        _ => None,
    }
}

pub(super) fn probe() -> (Support, Support, Option<u32>, Vec<String>) {
    let build = os_build();

    if glass_supported_for("windows", build) {
        return (Support::Supported, Support::Supported, build, Vec::new());
    }

    let note = match build {
        Some(build) => format!(
            "Glass needs Windows 11 22H2 (build {WINDOWS_GLASS_MIN_BUILD}); this system reports {build}."
        ),
        None => format!("Glass needs Windows 11 22H2 (build {WINDOWS_GLASS_MIN_BUILD}); this system did not report one."),
    };

    (Support::Supported, Support::Unsupported, build, vec![note])
}

pub(super) fn materials() -> Vec<FrostRung> {
    distinct_backdrop_rungs()
}

fn hwnd_of(window: &tauri::Window) -> Option<HWND> {
    window.hwnd().ok().map(|handle| handle.0 as HWND)
}

/// `WS_EX_LAYERED` + `LWA_ALPHA`. The style bit is REMOVED again at full
/// opacity: leaving a layered window sitting under a DWM backdrop is the
/// documented-shaky combination, and there is no reason to hold it when the
/// alpha is 255.
fn set_alpha(window: &tauri::Window, opacity: f64) -> GlassStep {
    let Some(hwnd) = hwnd_of(window) else {
        return GlassStep::Failed;
    };

    let alpha = (opacity.clamp(0.0, 1.0) * 255.0).round() as u8;

    // Safe: a sync `#[tauri::command]` runs on the main thread and the handle is
    // the live window Tauri just handed us.
    unsafe {
        let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let layered = isize::try_from(WS_EX_LAYERED).unwrap_or(0);

        if alpha == u8::MAX {
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style & !layered);

            return GlassStep::Applied;
        }

        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style | layered);

        if SetLayeredWindowAttributes(hwnd, 0, alpha, LWA_ALPHA) == 0 {
            return GlassStep::Failed;
        }
    }

    GlassStep::Applied
}

fn set_backdrop(window: &tauri::Window, backdrop: WindowsBackdrop) -> Result<GlassStep, String> {
    let result = match backdrop {
        WindowsBackdrop::Acrylic => {
            window_vibrancy::apply_acrylic(window, None).map(|()| GlassStep::Applied)
        }
        WindowsBackdrop::Tabbed => {
            window_vibrancy::apply_tabbed(window, None).map(|()| GlassStep::Applied)
        }
        WindowsBackdrop::Mica => {
            window_vibrancy::apply_mica(window, None).map(|()| GlassStep::Applied)
        }
        // One clear turns off whatever `DWMWA_SYSTEMBACKDROP_TYPE` carried.
        WindowsBackdrop::None => {
            window_vibrancy::clear_acrylic(window).map(|()| GlassStep::Cleared)
        }
    };

    result.map_err(|error| error.to_string())
}

pub(super) fn apply(window: &tauri::Window, want: &GlassRequest, changed: Changed) -> GlassOutcome {
    let build = os_build();
    let supported = glass_supported_for("windows", build);
    let wants_glass = glass_active(want) && supported;
    let mut note = None;

    let material = if !supported && glass_active(want) {
        let (.., notes) = probe();
        note = notes.into_iter().next();
        GlassStep::Unsupported
    } else if !changed.material {
        GlassStep::Unchanged
    } else {
        match set_backdrop(window, backdrop_for(want)) {
            Ok(step) => step,
            Err(error) => {
                note = Some(error);
                GlassStep::Failed
            }
        }
    };

    let opacity = if changed.opacity {
        set_alpha(window, window_opacity_for(want))
    } else {
        GlassStep::Unchanged
    };

    if opacity == GlassStep::Failed && note.is_none() {
        note = Some("The window handle is not available yet.".to_string());
    }

    GlassOutcome {
        effective_glass: wants_glass && material != GlassStep::Failed,
        material,
        opacity,
        note,
    }
}
