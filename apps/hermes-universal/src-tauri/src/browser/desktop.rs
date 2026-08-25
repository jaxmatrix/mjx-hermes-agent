//! The desktop adapter: a CHILD WEBVIEW inside the host window, positioned over
//! the pane rect.
//!
//! Compiled only with `tauri/unstable`, because `Window::add_child` is
//! `#[cfg(any(test, all(desktop, feature = "unstable")))]`. That feature is
//! semver-exempt, which is why `Cargo.toml` pins `tauri = "~2.11"`.
//!
//! Everything the Electron desktop app got from Chromium and Tauri does not
//! expose is either estimated and declared as estimated (`canGoBack` →
//! `history.rs`, `historySource: 'estimated'`), polled (`console`), or absent
//! and reported absent (native back/forward swipe: wry HAS
//! `with_back_forward_navigation_gestures` but tauri 2.11 never plumbs it, so
//! the bar's arrows and mouse buttons 3/4 are the only door).

use std::sync::{Arc, Mutex, Once};

use tauri::webview::{PageLoadEvent, WebviewBuilder};
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Url, WebviewUrl};
use tokio::sync::oneshot;

use super::{
    policy, ActInjection, BrowserCapabilities, BrowserError, BrowserErrorKind, ConsoleSource,
    ErrorEvent, GuestBounds, GuestHost, GuestId, HistorySource, HostKind, LoadErrorSource,
    NavVerdict, StoreKind,
};

pub fn capabilities(_app: &AppHandle) -> BrowserCapabilities {
    BrowserCapabilities {
        platform: super::platform_name(),
        host: HostKind::ChildWebview,
        // `data_directory` (Windows/Linux) / `data_store_identifier` (macOS).
        isolated_store: StoreKind::Own,
        history: HistorySource::Estimated,
        gestures: false,
        console: ConsoleSource::Poll,
        // tauri gates `open_devtools` on `debug_assertions` (we do not enable
        // its `devtools` feature), so a release build honestly has none and
        // the bar hides the glyph rather than offering a dead button.
        devtools: cfg!(debug_assertions),
        load_errors: LoadErrorSource::Timeout,
        act: ActInjection::Dom,
        notes: vec![
            "Back and forward are estimated from history.length; tauri exposes no history API."
                .to_string(),
            "No native back/forward swipe: wry has the flag, tauri 2.11 does not plumb it."
                .to_string(),
            "Console output is polled, not pushed.".to_string(),
        ],
    }
}

/// The script every guest document runs before its own scripts.
///
/// Three jobs, and nothing else — anything the guest could have loaded itself
/// does not belong in here:
///   1. a console ring the host drains by eval (there is no `console-message`
///      hook on a Tauri webview);
///   2. the keyboard chords, handled IN the guest because a child webview's key
///      events never reach the host document, so there is no
///      `commandFocusedGuest` to route them to;
///   3. the guest→host command channel, which is a refused navigation to
///      `hermes-guest:` — the only push path a webview with no IPC bridge has.
const GUEST_INIT: &str = r#"(function(){
  if (window.__hermesGuest) { return }
  var ring = [];
  var LIMIT = 500;
  window.__hermesGuest = {
    v: 1,
    drain: function () { var out = ring; ring = []; return out },
    send: function (cmd) { try { location.href = 'hermes-guest:' + cmd } catch (e) {} }
  };
  ['log', 'info', 'warn', 'error', 'debug'].forEach(function (level) {
    var original = console[level];
    console[level] = function () {
      try {
        var text = Array.prototype.map.call(arguments, function (a) {
          try { return typeof a === 'string' ? a : JSON.stringify(a) } catch (e) { return String(a) }
        }).join(' ');
        ring.push({ level: level, text: text.slice(0, 4000), at: Date.now() });
        if (ring.length > LIMIT) { ring.shift() }
      } catch (e) {}
      return original.apply(console, arguments)
    }
  });
  window.addEventListener('error', function (e) {
    ring.push({ level: 'error', text: String(e && e.message || e), source: e && e.filename, line: e && e.lineno, at: Date.now() });
    if (ring.length > LIMIT) { ring.shift() }
  }, true);
  window.addEventListener('keydown', function (e) {
    var mod = e.metaKey || e.ctrlKey;
    if (mod && !e.shiftKey && (e.code === 'KeyR')) { e.preventDefault(); location.reload(); return }
    if (e.altKey && e.code === 'ArrowLeft') { e.preventDefault(); history.back(); return }
    if (e.altKey && e.code === 'ArrowRight') { e.preventDefault(); history.forward(); return }
    if (mod && e.code === 'BracketLeft') { e.preventDefault(); history.back(); return }
    if (mod && e.code === 'BracketRight') { e.preventDefault(); history.forward() }
  }, true);
})()"#;

pub fn build(
    app: &AppHandle,
    owner_label: &str,
    id: &GuestId,
    url: &Url,
    bounds: GuestBounds,
) -> Result<Arc<dyn GuestHost>, BrowserError> {
    let window = app.get_window(owner_label).ok_or_else(|| {
        BrowserError::new(
            BrowserErrorKind::HostBuildFailed,
            format!("No window named {owner_label:?} to host the browser."),
        )
    })?;

    let label = policy::guest_label(id);
    let mut builder = WebviewBuilder::new(&label, WebviewUrl::External(url.clone()))
        .initialization_script(GUEST_INIT)
        .on_navigation({
            let app = app.clone();
            let id = id.clone();

            move |url| match policy::navigation_allowed(url) {
                NavVerdict::Allow => true,
                NavVerdict::Command(command) => {
                    super::on_guest_command(&app, &id, command);
                    false
                }
                NavVerdict::External => {
                    // A `mailto:` is a handoff, not a failure.
                    crate::open_url_externally(&app, url.as_str());
                    false
                }
                NavVerdict::Refuse => {
                    super::on_error(
                        &app,
                        &id,
                        ErrorEvent {
                            kind: "engine",
                            code: None,
                            description: "blocked-scheme".to_string(),
                            url: url.to_string(),
                        },
                    );
                    false
                }
            }
        })
        .on_page_load({
            let app = app.clone();
            let id = id.clone();

            move |_webview, payload| {
                super::on_load(
                    &app,
                    &id,
                    matches!(payload.event(), PageLoadEvent::Started),
                    payload.url().to_string(),
                );
            }
        })
        .on_download({
            let app = app.clone();

            move |_webview, event| {
                // v1 policy: writing a file the user did not choose, from a page
                // we do not control, needs a save-dialog design this ticket does
                // not have. Refusing loudly beats a silent drop.
                if let tauri::webview::DownloadEvent::Requested { url, .. } = event {
                    crate::open_url_externally(&app, url.as_str());
                }

                false
            }
        });

    // An uncontrolled second webview is an uncontrolled second ACL surface, so
    // `window.open` / `target=_blank` is refused and its URL routed back
    // through the same funnel every other link takes.
    builder = builder.on_new_window({
        let app = app.clone();

        move |url, _features| {
            crate::open_url_externally(&app, url.as_str());
            tauri::webview::NewWindowResponse::Deny
        }
    });

    builder = isolate_store(builder, app);

    let webview = window
        .add_child(
            builder,
            LogicalPosition::new(bounds.x, bounds.y),
            LogicalSize::new(bounds.width.max(1.0), bounds.height.max(1.0)),
        )
        .map_err(|e| {
            BrowserError::new(
                BrowserErrorKind::HostBuildFailed,
                format!("The in-app browser could not start on this system: {e}"),
            )
        })?;

    Ok(Arc::new(ChildWebviewHost { webview }))
}

/// The guest's cookies must not be the app's cookies: a browsed site's session
/// must never become app credential material, and it is never in
/// `TransportState.cookies`, `cookies_export`, or the keyring.
fn isolate_store<R: tauri::Runtime>(
    builder: WebviewBuilder<R>,
    app: &AppHandle,
) -> WebviewBuilder<R> {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        let _ = app;
        // A stable, app-specific identifier so the store survives a relaunch.
        builder.data_store_identifier(*b"hermes-guest-01\0")
    }

    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    {
        match app.path().app_data_dir() {
            Ok(dir) => builder.data_directory(dir.join("browser-guest")),
            // No data dir is not a reason to refuse to browse; it is a reason to
            // browse without a persistent store.
            Err(_) => builder.incognito(true),
        }
    }
}

struct ChildWebviewHost {
    webview: tauri::webview::Webview,
}

impl ChildWebviewHost {
    fn map(&self, result: tauri::Result<()>) -> Result<(), BrowserError> {
        result.map_err(|e| BrowserError::new(BrowserErrorKind::HostBuildFailed, e.to_string()))
    }
}

impl GuestHost for ChildWebviewHost {
    fn navigate(&self, url: &Url) -> Result<(), BrowserError> {
        self.map(self.webview.navigate(url.clone()))
    }

    fn back(&self) -> Result<(), BrowserError> {
        // tauri exposes no history API on a webview (only `reload`), so the
        // page moves itself. `history.rs` is what keeps the buttons honest.
        self.map(self.webview.eval("history.go(-1)"))
    }

    fn forward(&self) -> Result<(), BrowserError> {
        self.map(self.webview.eval("history.go(1)"))
    }

    fn reload(&self) -> Result<(), BrowserError> {
        self.map(self.webview.reload())
    }

    fn stop(&self) -> Result<(), BrowserError> {
        self.map(self.webview.eval("window.stop()"))
    }

    fn set_bounds(&self, bounds: GuestBounds) -> Result<(), BrowserError> {
        self.map(
            self.webview
                .set_position(LogicalPosition::new(bounds.x, bounds.y)),
        )?;

        self.map(self.webview.set_size(LogicalSize::new(
            bounds.width.max(1.0),
            bounds.height.max(1.0),
        )))
    }

    fn set_visible(&self, visible: bool) -> Result<bool, BrowserError> {
        self.map(if visible {
            self.webview.show()
        } else {
            self.webview.hide()
        })?;

        Ok(visible)
    }

    fn eval(&self, js: &str) -> Result<oneshot::Receiver<String>, BrowserError> {
        let (tx, rx) = oneshot::channel();
        let tx = Arc::new(Mutex::new(Some(tx)));
        // wry can fire a callback more than once on some engines, and firing on
        // a closed channel after a timeout would panic in a foreign callback.
        let once = Once::new();
        let once = Arc::new(once);

        self.map(self.webview.eval_with_callback(js, move |value| {
            let tx = Arc::clone(&tx);

            once.call_once(move || {
                if let Some(tx) = tx.lock().ok().and_then(|mut slot| slot.take()) {
                    let _ = tx.send(value);
                }
            });
        }))?;

        Ok(rx)
    }

    fn clear_data(&self) -> Result<(), BrowserError> {
        self.map(self.webview.clear_all_browsing_data())
    }

    fn open_devtools(&self) -> Result<bool, BrowserError> {
        #[cfg(debug_assertions)]
        {
            self.webview.open_devtools();
            Ok(true)
        }

        // There is no `is_devtools_open` on a child webview either, so the
        // glyph is a two-state button reflecting OUR last command, not a
        // mirror — which is why this returns whether it opened.
        #[cfg(not(debug_assertions))]
        {
            Ok(false)
        }
    }

    fn close(&self) -> Result<(), BrowserError> {
        self.map(self.webview.close())
    }
}
