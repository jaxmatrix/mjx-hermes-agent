//! `hermes://` — the OS front door.
//!
//! Rust owns the OS lever (scheme registration, the single-instance handoff, the
//! window raise) and NOTHING else: it does not parse the URL, does not know what
//! a route means, and never navigates. The grammar and the routing live in the
//! webview (`src/lib/deep-link-routes.ts`, `src/store/deep-link.ts`), which is
//! where every other navigation decision already lives.
//!
//! THE PROBLEM THIS MODULE EXISTS FOR is timing. A link can arrive before a
//! webview has mounted a listener — on Android a cold launch from a tapped link
//! is the NORMAL case, not an edge — and `emit_to` into a window that is not
//! listening yet is a silent drop. So links are buffered until the main webview
//! says it is ready, and the readiness flag is CLEARED when `main` is destroyed
//! so a reload (or an Android process recreation) re-buffers instead of emitting
//! into nothing.
//!
//! The buffer is bounded: a page in a loop opening `hermes://…` must not be able
//! to grow it without limit before anything exists to drain it. Overflow drops
//! the OLDEST — the newest intent is the one the user just expressed — and the
//! count is REPORTED at the drain rather than swallowed (rule 9).
//!
//! Delivery is `emit_to("main", …)`, never `emit`: exactly one window may act on
//! a link, or a user with a detached tile open gets two install dialogs (rule 23).

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

/// The app-level Tauri event carrying one opened URL to the webview.
///
/// INVARIANT (and `parseHermesDeepLink` enforces the other half): an app EVENT
/// name is `hermes://<kebab-name>` with NO path, while a deep-link ROUTE is
/// `hermes://<kind>/<name>` and always has a non-empty one. That is what keeps
/// the two meanings of the `hermes://` prefix provably disjoint now that the
/// scheme is registered with five operating systems. Do not add a path segment
/// to an event name, and do not mint a route with an empty path.
pub const DEEP_LINK_OPEN_EVENT: &str = "hermes://deep-link-open";

/// Bounded so a link storm cannot grow the queue without limit before a webview
/// exists to drain it. Drop-OLDEST: the newest intent is the live one.
const MAX_PENDING_DEEP_LINKS: usize = 8;

#[derive(Default)]
pub struct DeepLinkState {
    /// Links that arrived before a webview said it was listening.
    pending: Mutex<VecDeque<String>>,
    /// The main webview has mounted its listener. Cleared when `main` is
    /// destroyed, so a reload re-buffers instead of emitting into nothing.
    ready: AtomicBool,
    /// How many links the cap discarded since the last drain — reported, never
    /// silent.
    dropped: AtomicU32,
}

impl DeepLinkState {
    /// Take one opened URL. `Some(url)` = deliver it now, `None` = buffered.
    ///
    /// Chosen lock: `std::sync::Mutex`. Every access is synchronous with no
    /// `await` inside, and the poisoned branch takes the guard anyway — a panic
    /// in another thread must not make the app stop answering deep links.
    fn accept(&self, url: String) -> Option<String> {
        if self.ready.load(Ordering::SeqCst) {
            return Some(url);
        }

        let mut pending = self.pending.lock().unwrap_or_else(|err| err.into_inner());

        while pending.len() >= MAX_PENDING_DEEP_LINKS {
            pending.pop_front();
            self.dropped.fetch_add(1, Ordering::SeqCst);
        }

        pending.push_back(url);

        None
    }

    /// Mark ready and take everything buffered, FIFO, plus the dropped count.
    ///
    /// `ready` flips BEFORE the queue is emptied, deliberately: a link arriving
    /// while the caller is still emitting the drained batch must be delivered
    /// rather than queued behind a queue nothing will look at again.
    fn drain(&self) -> (Vec<String>, u32) {
        self.ready.store(true, Ordering::SeqCst);

        let mut pending = self.pending.lock().unwrap_or_else(|err| err.into_inner());

        (
            pending.drain(..).collect(),
            self.dropped.swap(0, Ordering::SeqCst),
        )
    }

    /// The main webview went away. The next link buffers again.
    fn forget_ready(&self) {
        self.ready.store(false, Ordering::SeqCst);
    }
}

/// What `deep_link_ready` answers with. Both halves matter: `delivered` tells the
/// webview whether the launch link has already landed, `dropped` is the cap
/// admitting it discarded something.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeepLinkDrain {
    delivered: u32,
    dropped: u32,
}

#[derive(Clone, Serialize)]
struct DeepLinkOpen {
    url: String,
}

/// Best-effort raise of the main window. Rule 10: `set_focus` is a documented
/// no-op on Wayland, so nothing here is awaited and nothing claims it worked —
/// the link still routes either way.
#[cfg(desktop)]
fn raise_main(app: &AppHandle) {
    let app = app.clone();

    // gtk/WKWebView window ops must run on the main thread (see window.rs).
    let _ = app.clone().run_on_main_thread(move || {
        let Some(window) = app.get_webview_window("main") else {
            return;
        };

        // Unminimize first: `show()` on a minimized window leaves it minimized on
        // Windows and on several Linux WMs.
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    });
}

/// Emit one URL to the main webview. Returns whether the emit was accepted.
fn deliver(app: &AppHandle, url: String) -> bool {
    #[cfg(desktop)]
    raise_main(app);

    // On mobile the intent/scene has already foregrounded us — there is no
    // second window to raise, and `finish()`-style juggling is exactly what the
    // single-webview rule forbids.
    app.emit_to("main", DEEP_LINK_OPEN_EVENT, DeepLinkOpen { url })
        .is_ok()
}

/// Buffer or deliver one opened URL.
fn open_url(app: &AppHandle, url: String) {
    if let Some(url) = app.state::<DeepLinkState>().accept(url) {
        deliver(app, url);
    }
}

/// Wire the plugin's callbacks. Call from `.setup()`.
///
/// ORDERING: `get_current()` is read BEFORE `on_open_url` is installed, so the
/// launch URL cannot be counted twice. On macOS the plugin buffers `open-url`
/// events that fire before setup and `get_current` returns them, so the single
/// read covers both the cold-start and the already-running cases.
pub fn setup(app: &AppHandle) {
    use tauri_plugin_deep_link::DeepLinkExt;

    if let Ok(Some(urls)) = app.deep_link().get_current() {
        for url in urls {
            open_url(app, url.to_string());
        }
    }

    let handle = app.clone();

    app.deep_link().on_open_url(move |event| {
        for url in event.urls() {
            open_url(&handle, url.to_string());
        }
    });

    // A dev build has no installer to write the registry/`.desktop` entry, so it
    // claims its OWN scheme at runtime rather than fighting an installed release
    // for `hermes`. Unsupported on macOS (and the plugin says so by returning an
    // error), which is why the result is discarded rather than reported: there is
    // nothing a user could do about it.
    #[cfg(all(desktop, debug_assertions))]
    let _ = app.deep_link().register("hermes-dev");
}

/// The main webview was destroyed (a reload, an Android process recreation).
/// Buffer again until its replacement re-announces itself.
pub fn forget_ready(app: &AppHandle) {
    app.state::<DeepLinkState>().forget_ready();
}

/// "I am listening" — drains whatever arrived first.
///
/// Idempotent and RE-CALLABLE: a webview reload calls it again and drains
/// whatever buffered while it was gone. That is the whole reason `ready` is
/// cleared on `Destroyed` rather than being a one-shot latch.
#[tauri::command]
pub fn deep_link_ready(
    app: AppHandle,
    state: tauri::State<'_, DeepLinkState>,
) -> Result<DeepLinkDrain, String> {
    let (urls, dropped) = state.drain();
    let mut delivered = 0;

    for url in urls {
        if deliver(&app, url) {
            delivered += 1;
        }
    }

    Ok(DeepLinkDrain { delivered, dropped })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn buffers_until_ready_then_drains_fifo() {
        let state = DeepLinkState::default();

        assert!(state.accept("hermes://mcp/install?name=a".into()).is_none());
        assert!(state.accept("hermes://mcp/install?name=b".into()).is_none());

        let (urls, dropped) = state.drain();

        assert_eq!(
            urls,
            vec![
                "hermes://mcp/install?name=a".to_string(),
                "hermes://mcp/install?name=b".to_string()
            ]
        );
        assert_eq!(dropped, 0);
    }

    #[test]
    fn drain_flips_ready_so_the_next_link_is_delivered_not_queued() {
        let state = DeepLinkState::default();
        state.drain();

        // The whole point of flipping `ready` before emptying the queue: a link
        // that arrives while the caller is still emitting must be handed back for
        // delivery, not parked behind a queue nobody will drain again.
        assert_eq!(
            state.accept("hermes://plugin/install?repo=o/r".into()),
            Some("hermes://plugin/install?repo=o/r".to_string())
        );

        // ...and the queue really is empty, so this is not a "drained twice" pass.
        assert_eq!(state.drain().0, Vec::<String>::new());
    }

    #[test]
    fn the_cap_drops_the_oldest_and_counts_it() {
        let state = DeepLinkState::default();

        for i in 0..(MAX_PENDING_DEEP_LINKS + 3) {
            state.accept(format!("hermes://open/{i}"));
        }

        let (urls, dropped) = state.drain();

        assert_eq!(urls.len(), MAX_PENDING_DEEP_LINKS);
        // The OLDEST three went, not the newest three.
        assert_eq!(urls.first().unwrap(), "hermes://open/3");
        assert_eq!(urls.last().unwrap(), "hermes://open/10");
        assert_eq!(dropped, 3);
    }

    #[test]
    fn the_dropped_count_is_reported_once_and_then_reset() {
        let state = DeepLinkState::default();

        for i in 0..(MAX_PENDING_DEEP_LINKS + 1) {
            state.accept(format!("hermes://open/{i}"));
        }

        assert_eq!(state.drain().1, 1);

        state.forget_ready();
        state.accept("hermes://open/late".into());

        assert_eq!(state.drain().1, 0);
    }

    #[test]
    fn forgetting_ready_re_buffers_instead_of_emitting_into_nothing() {
        let state = DeepLinkState::default();
        state.drain();
        state.forget_ready();

        assert!(state.accept("hermes://open/after-reload".into()).is_none());
        assert_eq!(
            state.drain().0,
            vec!["hermes://open/after-reload".to_string()]
        );
    }
}
