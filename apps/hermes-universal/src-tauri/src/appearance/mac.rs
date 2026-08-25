//! macOS glass backend: `NSVisualEffectView` vibrancy + `NSWindow.alphaValue`.
//!
//! `window-vibrancy` is called directly rather than through Tauri's
//! `Window::set_effects`, which discards the crate's `Result` and reports
//! success unconditionally (see the module header) — the whole point of this
//! backend is that a refusal comes back as one.
//!
//! `NSVisualEffectState::Active` is pinned deliberately. On the default
//! (`FollowsWindowActiveState`) two of the four rungs collapse into each other
//! the moment the window loses focus, which shipped once as two picker options
//! that looked identical.
//!
//! The alpha lever is a raw `objc2` message rather than `objc2-app-kit`: it is
//! one selector on an object we already hold a pointer to, and `objc2` is
//! already a declared dependency for both Apple targets.

use objc2::runtime::AnyObject;
use window_vibrancy::{
    apply_vibrancy, clear_vibrancy, NSVisualEffectMaterial, NSVisualEffectState,
};

use super::model::{
    all_rungs, frost_spec, glass_active, window_opacity_for, Changed, FrostRung, GlassRequest,
};
use super::{GlassOutcome, GlassStep};
use crate::surface::Support;

pub(super) fn probe() -> (Support, Support, Option<u32>, Vec<String>) {
    (Support::Supported, Support::Supported, None, Vec::new())
}

pub(super) fn materials() -> Vec<FrostRung> {
    all_rungs()
}

/// `FROST_TABLE`'s raw `NSVisualEffectMaterial` value → the crate's enum. The
/// table stays the single place a rung is described; this is only the crossing
/// into a type that cannot be named on other targets.
fn ns_material(rung: FrostRung) -> NSVisualEffectMaterial {
    match frost_spec(rung).ns_material {
        3 => NSVisualEffectMaterial::Titlebar,
        6 => NSVisualEffectMaterial::Popover,
        10 => NSVisualEffectMaterial::HeaderView,
        _ => NSVisualEffectMaterial::UnderWindowBackground,
    }
}

fn set_alpha(window: &tauri::Window, alpha: f64) -> GlassStep {
    let Ok(ns_window) = window.ns_window() else {
        return GlassStep::Failed;
    };

    if ns_window.is_null() {
        return GlassStep::Failed;
    }

    // Safe: a sync `#[tauri::command]` runs on the main thread, and the pointer
    // is the live `NSWindow` Tauri just handed us.
    unsafe {
        let ns_window = ns_window.cast::<AnyObject>();
        let _: () = objc2::msg_send![ns_window, setAlphaValue: alpha];
    }

    GlassStep::Applied
}

pub(super) fn apply(window: &tauri::Window, want: &GlassRequest, changed: Changed) -> GlassOutcome {
    let wants_glass = glass_active(want);
    let mut note = None;

    let material = if !changed.material {
        GlassStep::Unchanged
    } else if wants_glass {
        match apply_vibrancy(
            window,
            ns_material(want.material),
            Some(NSVisualEffectState::Active),
            None,
        ) {
            Ok(()) => GlassStep::Applied,
            Err(error) => {
                note = Some(error.to_string());
                GlassStep::Failed
            }
        }
    } else {
        match clear_vibrancy(window) {
            Ok(_) => GlassStep::Cleared,
            Err(error) => {
                note = Some(error.to_string());
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
        note = Some("The NSWindow is not available yet.".to_string());
    }

    GlassOutcome {
        // What the window carries RIGHT NOW, not what was asked for: a failed
        // apply leaves it bare and the page must not thin itself over nothing.
        effective_glass: wants_glass && material != GlassStep::Failed,
        material,
        opacity,
        note,
    }
}
