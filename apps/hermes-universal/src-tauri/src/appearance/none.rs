//! The honest "no lever here" backend: Android, iOS, and any desktop OS with no
//! implementation of its own.
//!
//! Stated plainly for mobile, because it is a product decision and not an
//! omission: window glass is a window-manager feature and a phone has no window
//! manager to show through. Android's WebView fills its Activity and iOS's fills
//! its Scene, so a "translucent app" would blur its own background — a frosted
//! picture of nothing. The Appearance page therefore shows no translucency row
//! at all rather than a disabled one, because a disabled control is a promise
//! the platform cannot keep.
//!
//! Compiled unconditionally on the targets that have no backend so the shape
//! stays type-checked; `appearance_set_glass` short-circuits on mobile before
//! `apply` is ever reached.

use super::model::{Changed, FrostRung, GlassRequest};
use super::{GlassOutcome, GlassStep};
use crate::surface::Support;

pub(super) fn probe() -> (Support, Support, Option<u32>, Vec<String>) {
    (
        Support::Unsupported,
        Support::Unsupported,
        None,
        vec!["This platform has no window translucency.".to_string()],
    )
}

pub(super) fn materials() -> Vec<FrostRung> {
    Vec::new()
}

#[cfg_attr(mobile, allow(dead_code))]
pub(super) fn apply(window: &tauri::Window, want: &GlassRequest, changed: Changed) -> GlassOutcome {
    let _ = (window, want, changed);

    GlassOutcome {
        material: GlassStep::Unsupported,
        opacity: GlassStep::Unsupported,
        effective_glass: false,
        note: Some("This platform has no window translucency.".to_string()),
    }
}
