//! Linux glass backend — the one lever that has always worked here.
//!
//! GTK's toplevel opacity, i.e. exactly what `appearance.rs` did before this
//! module existed. Unlike Electron's `setOpacity` (a no-op on Linux, which is
//! why the desktop app hides Clear here) this composites correctly under any
//! compositor, so Clear is SUPPORTED and it is *glass* that is not: there is no
//! first-party wlroots/GNOME/KDE window material to ask for.
//!
//! The window also stays OPAQUE on Linux — `tauri.linux.conf.json` does not
//! exist and `app_window_builder` does not set the flag. An RGBA visual on an
//! X11 session with no compositor renders black, which would be a real
//! regression for the one platform whose translucency already worked.

use gtk::prelude::WidgetExt;

use super::model::{window_opacity_for, Changed, FrostRung, GlassRequest};
use super::{GlassOutcome, GlassStep};
use crate::surface::Support;

pub(super) fn probe() -> (Support, Support, Option<u32>, Vec<String>) {
    (
        Support::Supported,
        Support::Unsupported,
        None,
        vec![
            "This desktop provides no window material, so the compositor owns blur here."
                .to_string(),
        ],
    )
}

pub(super) fn materials() -> Vec<FrostRung> {
    Vec::new()
}

pub(super) fn apply(window: &tauri::Window, want: &GlassRequest, changed: Changed) -> GlassOutcome {
    let opacity = if changed.opacity {
        match window.gtk_window() {
            Ok(gtk_window) => {
                gtk_window.set_opacity(window_opacity_for(want));
                GlassStep::Applied
            }
            Err(_) => GlassStep::Failed,
        }
    } else {
        GlassStep::Unchanged
    };

    GlassOutcome {
        material: GlassStep::Unsupported,
        opacity,
        effective_glass: false,
        note: (opacity == GlassStep::Failed)
            .then(|| "The GTK toplevel is not available yet.".to_string()),
    }
}
