//! Native window appearance: translucency (Clear) and compositor glass.
//!
//! Two commands, and both of them tell the truth about what happened.
//!
//! Tauri core ships `Window::set_effects`, and it is exactly the trap §5 rule 10
//! exists for: `tauri/src/vibrancy/mod.rs` calls the platform apply, **drops its
//! `Result`**, and returns `Ok(())` — on Linux it does nothing at all and still
//! returns `Ok(())`. A frontend that believed it would report "frosted" over a
//! window that is not. So this module calls `window-vibrancy` directly, where
//! there is a `Result` to report, and hands the webview a [`GlassOutcome`] it
//! can act on.
//!
//! Universal inverts the desktop app's platform story rather than porting it.
//! Electron's `setOpacity` no-ops on Linux, so desktop offers Clear on
//! macOS/Windows only. Here GTK opacity is the lever that has always worked, and
//! macOS/Windows window alpha was a `TODO` — so Clear ships on all three desktop
//! OSes, and it is *glass* that Linux cannot do (no first-party compositor
//! material). The frontend never guesses any of this: it asks
//! [`appearance_capabilities`] first (§5 rules 9 and 10).
//!
//! State is keyed by WINDOW LABEL because every window here is its own WebView
//! pushing for itself (§5 rule 21) — there is no privileged process fanning out.

mod model;

#[cfg(target_os = "linux")]
#[path = "linux.rs"]
mod backend;
#[cfg(target_os = "macos")]
#[path = "mac.rs"]
mod backend;
#[cfg(target_os = "windows")]
#[path = "win.rs"]
mod backend;
#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
#[path = "none.rs"]
mod backend;

use std::collections::HashMap;
use std::sync::Mutex;

use serde::Serialize;

#[cfg(test)]
use model::GlassMode;
// `changed`/`Changed` are the per-window diff, which mobile never reaches — its
// command refuses before it gets there.
#[cfg_attr(mobile, allow(unused_imports))]
use model::{changed, Changed, FrostRung, GlassRequest};

use crate::surface::Support;

/// What this OS can actually do — asked once per WebView, before the settings
/// rows are offered. A capability is never inferred from a call that did not
/// throw (§5 rule 10).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppearanceCapabilities {
    /// `std::env::consts::OS`.
    pub platform: &'static str,
    /// Whether ANY translucency lever exists here (Clear).
    pub translucency: Support,
    /// Whether a compositor material exists here (Glass).
    pub glass: Support,
    /// The frost rungs this OS renders as DISTINCT looks; empty when glass is
    /// off. The picker renders this list, so a new platform grows it with no
    /// TypeScript change at all.
    pub materials: Vec<FrostRung>,
    /// Windows build number; `null` everywhere else.
    pub os_build: Option<u32>,
    /// Human/log text. Constants plus an integer build — never a URL, a path or
    /// a hostname, so nothing here needs `redact_url` (§5 rule 34). Keep it that
    /// way.
    pub notes: Vec<String>,
}

/// Whether one half of an apply landed. `Unchanged` is not a failure: it is the
/// diff saying this window already carries what was asked for.
///
/// Every variant is part of the IPC contract; which of them a given target can
/// actually produce is a platform fact (`Cleared` needs a material to clear), so
/// the unconstructed-variant check stays on where the full set is reachable.
#[cfg_attr(not(any(target_os = "macos", target_os = "windows")), allow(dead_code))]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum GlassStep {
    Applied,
    Cleared,
    Unchanged,
    Unsupported,
    Failed,
}

/// What `appearance_set_glass` actually did. A cosmetic native refusal is never
/// an `Err` — the frontend branches on this, drops its DOM flags and degrades,
/// and nothing is surfaced to the user (recipe 6.2).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlassOutcome {
    pub material: GlassStep,
    pub opacity: GlassStep,
    /// Whether a material is on this window RIGHT NOW. The webview believes
    /// this, not its own request.
    pub effective_glass: bool,
    pub note: Option<String>,
}

/// The last request applied per window label.
///
/// A plain `std::sync::Mutex`: `appearance_set_glass` is deliberately SYNC (a
/// sync `#[tauri::command]` runs on the main thread, which is what makes the
/// GTK / AppKit / DWM calls legal), so the lock is never held across an `await`.
#[derive(Default)]
pub struct AppearanceState {
    applied: Mutex<HashMap<String, GlassRequest>>,
}

#[cfg_attr(mobile, allow(dead_code))]
impl AppearanceState {
    fn diff(&self, label: &str, next: &GlassRequest) -> Changed {
        let applied = self.applied.lock().ok();

        changed(applied.as_ref().and_then(|map| map.get(label)), next)
    }

    fn remember(&self, label: &str, next: GlassRequest) {
        if let Ok(mut applied) = self.applied.lock() {
            applied.insert(label.to_string(), next);
        }
    }

    fn forget(&self, label: &str) {
        if let Ok(mut applied) = self.applied.lock() {
            applied.remove(label);
        }
    }
}

/// Drop a closed window's row, or a long session of opened and closed tiles
/// leaks one small struct per label (recipe 6.11 §5).
pub fn reap_window(app: &tauri::AppHandle, label: &str) {
    use tauri::Manager;

    app.state::<AppearanceState>().forget(label);
}

#[tauri::command]
pub fn appearance_capabilities() -> AppearanceCapabilities {
    let (translucency, glass, os_build, notes) = backend::probe();
    let supported = glass == Support::Supported;

    AppearanceCapabilities {
        platform: std::env::consts::OS,
        translucency,
        glass,
        materials: if supported {
            backend::materials()
        } else {
            Vec::new()
        },
        os_build,
        notes,
    }
}

/// Push the resolved NATIVE half onto the CALLING window.
///
/// Synchronous on purpose: a sync command runs on the main thread, and GTK,
/// AppKit and DWM all require it (`window-vibrancy` even has a `NotMainThread`
/// error for the mistake). Never make this `async` without `run_on_main_thread`.
///
/// The window is the one Tauri injects, never a label the JS supplies — the same
/// rule that keeps `sat-*` unforgeable (§5 rule 5).
#[cfg(desktop)]
#[tauri::command]
pub fn appearance_set_glass(
    window: tauri::Window,
    state: GlassRequest,
    applied: tauri::State<'_, AppearanceState>,
) -> Result<GlassOutcome, String> {
    let label = window.label().to_string();
    let diff = applied.diff(&label, &state);
    let outcome = backend::apply(&window, &state, diff);

    // Remember what was ASKED for only when the window took it. A refusal that
    // recorded itself would make the next identical push report `unchanged` over
    // a window that never got the effect.
    if outcome.material != GlassStep::Failed && outcome.opacity != GlassStep::Failed {
        applied.remember(&label, state);
    } else {
        applied.forget(&label);
    }

    Ok(outcome)
}

/// A phone has no window manager to show through, the row does not exist there,
/// and nothing should be calling this. The error string is kept verbatim from
/// the `set_window_translucency` this module replaces.
#[cfg(mobile)]
#[tauri::command]
pub fn appearance_set_glass(_state: GlassRequest) -> Result<GlassOutcome, String> {
    Err("unsupported_platform".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(mode: GlassMode, intensity: u8) -> GlassRequest {
        GlassRequest {
            mode,
            intensity,
            fade: 0,
            material: FrostRung::Popover,
        }
    }

    #[test]
    fn a_second_identical_push_is_unchanged() {
        let state = AppearanceState::default();
        let want = request(GlassMode::Clear, 40);

        assert!(state.diff("main", &want).any());
        state.remember("main", want);
        assert!(!state.diff("main", &want).any());
    }

    #[test]
    fn labels_do_not_share_state() {
        let state = AppearanceState::default();
        let want = request(GlassMode::Clear, 40);

        state.remember("main", want);

        assert!(state.diff("tile-files", &want).any());
    }

    #[test]
    fn a_reaped_label_starts_over() {
        let state = AppearanceState::default();
        let want = request(GlassMode::Clear, 40);

        state.remember("main", want);
        state.forget("main");

        assert_eq!(state.diff("main", &want), Changed::all());
    }
}
