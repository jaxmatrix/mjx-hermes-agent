//! The mobile adapter: a native `android.webkit.WebView` / `WKWebView` owned by
//! `tauri-plugin-browser`, attached at the pane rect.
//!
//! Mobile is where the guest is genuinely BETTER than the desktop one, and the
//! capability descriptor says so rather than pretending the platforms are
//! equal: `canGoBack()` is engine truth instead of a counted estimate,
//! `onConsoleMessage` / `WKUIDelegate` push console lines instead of being
//! polled, `onReceivedError` carries a real code, and iOS has a real edge-swipe
//! back gesture — the one thing no desktop target can do, because tauri never
//! plumbs wry's `back_forward_navigation_gestures`.
//!
//! Every `run_mobile_plugin` call blocks the calling thread until the native
//! side resolves, which is why the eval path hands work to a blocking task
//! rather than awaiting on the runtime's worker.

use std::sync::Arc;

use tauri::{AppHandle, Url};
use tauri_plugin_browser::{
    Bounds, BoundsRequest, BrowserExt, EvalRequest, GuestEvent, GuestRequest, NavigateRequest,
    OpenRequest, VisibleRequest,
};
use tokio::sync::oneshot;

use super::{
    ActInjection, BrowserCapabilities, BrowserError, BrowserErrorKind, ConsoleSource, ErrorEvent,
    GuestBounds, GuestHost, GuestId, HistorySource, HostKind, LoadErrorSource, StoreKind,
};

fn failed(err: impl std::fmt::Display) -> BrowserError {
    BrowserError::new(BrowserErrorKind::HostBuildFailed, err.to_string())
}

pub fn capabilities(app: &AppHandle) -> BrowserCapabilities {
    let platform = super::platform_name();

    let Ok(native) = app.browser_host().capabilities() else {
        // The plugin failed to register at all. Say so — an empty rectangle
        // with no explanation is the failure mode this whole descriptor exists
        // to prevent.
        return BrowserCapabilities {
            platform,
            host: HostKind::None,
            isolated_store: StoreKind::Ephemeral,
            history: HistorySource::Estimated,
            gestures: false,
            console: ConsoleSource::None,
            devtools: false,
            load_errors: LoadErrorSource::Timeout,
            act: ActInjection::Dom,
            notes: vec!["The native WebView plugin did not register.".to_string()],
        };
    };

    BrowserCapabilities {
        platform,
        host: HostKind::NativeView,
        isolated_store: match native.isolated_store.as_str() {
            "own" => StoreKind::Own,
            "shared" => StoreKind::Shared,
            _ => StoreKind::Ephemeral,
        },
        history: if native.history_engine {
            HistorySource::Engine
        } else {
            HistorySource::Estimated
        },
        gestures: native.gestures,
        console: if native.console_push {
            ConsoleSource::Push
        } else {
            ConsoleSource::Poll
        },
        // Android's inspector is chrome://inspect, iOS's is Safari Web
        // Inspector. Both are external, so there is no glyph to offer.
        devtools: false,
        load_errors: LoadErrorSource::Engine,
        act: ActInjection::Dom,
        notes: native.notes,
    }
}

pub fn build(
    app: &AppHandle,
    _owner_label: &str,
    id: &GuestId,
    url: &Url,
    bounds: GuestBounds,
) -> Result<Arc<dyn GuestHost>, BrowserError> {
    let on_event = {
        let app = app.clone();

        tauri::ipc::Channel::new(move |message| {
            if let Ok(event) = message.deserialize::<GuestEvent>() {
                route(&app, event);
            }

            Ok(())
        })
    };

    app.browser_host()
        .open(OpenRequest {
            guest_id: id.clone(),
            url: url.to_string(),
            bounds: to_bounds(bounds),
            on_event,
        })
        .map_err(failed)?;

    Ok(Arc::new(NativeViewHost {
        app: app.clone(),
        id: id.clone(),
    }))
}

fn to_bounds(b: GuestBounds) -> Bounds {
    Bounds {
        x: b.x,
        y: b.y,
        width: b.width.max(1.0),
        height: b.height.max(1.0),
    }
}

/// Native → Rust. The native halves never decide anything: they report, and the
/// shared lifecycle in `browser/mod.rs` folds it into one guest state.
fn route(app: &AppHandle, event: GuestEvent) {
    match event {
        GuestEvent::Load {
            guest_id,
            started,
            url,
        } => super::on_load(app, &guest_id, started, url),

        GuestEvent::Nav {
            guest_id,
            url,
            title,
            can_back,
            can_forward,
        } => {
            let app = app.clone();

            tauri::async_runtime::spawn(async move {
                super::publish_engine_nav(&app, &guest_id, url, title, can_back, can_forward).await;
            });
        }

        GuestEvent::Error {
            guest_id,
            code,
            description,
            url,
        } => super::on_error(
            app,
            &guest_id,
            ErrorEvent {
                kind: "engine",
                code,
                description,
                url,
            },
        ),

        GuestEvent::Console { guest_id, entries } => super::on_console(app, &guest_id, entries),

        // A `mailto:`, a refused `target=_blank`, a download: the same handoff
        // the desktop guard makes, decided in Rust so both platforms agree.
        GuestEvent::External { guest_id: _, url } => crate::open_url_externally(app, &url),
    }
}

struct NativeViewHost {
    app: AppHandle,
    id: GuestId,
}

impl NativeViewHost {
    fn guest(&self) -> GuestRequest {
        GuestRequest {
            guest_id: self.id.clone(),
        }
    }
}

impl GuestHost for NativeViewHost {
    fn navigate(&self, url: &Url) -> Result<(), BrowserError> {
        self.app
            .browser_host()
            .navigate(NavigateRequest {
                guest_id: self.id.clone(),
                url: url.to_string(),
            })
            .map_err(failed)
    }

    fn back(&self) -> Result<(), BrowserError> {
        self.app.browser_host().back(self.guest()).map_err(failed)
    }

    fn forward(&self) -> Result<(), BrowserError> {
        self.app
            .browser_host()
            .forward(self.guest())
            .map_err(failed)
    }

    fn reload(&self) -> Result<(), BrowserError> {
        self.app.browser_host().reload(self.guest()).map_err(failed)
    }

    fn stop(&self) -> Result<(), BrowserError> {
        self.app.browser_host().stop(self.guest()).map_err(failed)
    }

    fn set_bounds(&self, bounds: GuestBounds) -> Result<(), BrowserError> {
        self.app
            .browser_host()
            .set_bounds(BoundsRequest {
                guest_id: self.id.clone(),
                bounds: to_bounds(bounds),
            })
            .map_err(failed)
    }

    fn set_visible(&self, visible: bool) -> Result<bool, BrowserError> {
        self.app
            .browser_host()
            .set_visible(VisibleRequest {
                guest_id: self.id.clone(),
                visible,
            })
            .map(|answer| answer.visible)
            .map_err(failed)
    }

    fn eval(&self, js: &str) -> Result<oneshot::Receiver<String>, BrowserError> {
        let (tx, rx) = oneshot::channel();
        let app = self.app.clone();
        let request = EvalRequest {
            guest_id: self.id.clone(),
            script: js.to_string(),
        };

        // `run_mobile_plugin` blocks until the native completion handler fires.
        // On a runtime worker that would stall every other command; the caller
        // already has a timeout around the receiver, so a dropped sender is a
        // handled outcome rather than a lost one.
        tauri::async_runtime::spawn_blocking(move || {
            let answer = app
                .browser_host()
                .eval(request)
                .map(|response| response.value);

            if let Ok(value) = answer {
                let _ = tx.send(value);
            }
        });

        Ok(rx)
    }

    fn clear_data(&self) -> Result<(), BrowserError> {
        self.app
            .browser_host()
            .clear_data(self.guest())
            .map_err(failed)
    }

    fn open_devtools(&self) -> Result<bool, BrowserError> {
        // chrome://inspect and Safari Web Inspector are both external tools;
        // there is nothing for this to open.
        Err(BrowserError::unsupported())
    }

    fn close(&self) -> Result<(), BrowserError> {
        self.app.browser_host().close(self.guest()).map_err(failed)
    }
}
