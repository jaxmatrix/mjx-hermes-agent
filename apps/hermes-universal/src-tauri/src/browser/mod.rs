//! The guest-webview host: a real, isolated browser inside a Hermes pane on all
//! five targets, owned by Rust.
//!
//! This is not a port of the Electron desktop app's `<webview>` tag — none of
//! that tag's mechanisms (`executeJavaScript`, `sendInputEvent`,
//! `console-message`, `canGoBack`, a `persist:` partition) exist here. What
//! universal builds instead is one trait with a per-platform adapter:
//!
//!   * desktop — a CHILD WEBVIEW inside the host window (`Window::add_child`,
//!     behind `tauri/unstable`), positioned over the pane rect;
//!   * Android/iOS — a native `WebView` / `WKWebView` owned by our own in-tree
//!     `tauri-plugin-browser`, because a mobile "window" is an Activity/Scene
//!     and a native view is the only thing that can sit at a rect;
//!   * anything else — `stub::NoHost`, which refuses loudly (rule 9).
//!
//! Two properties are load-bearing and are enforced elsewhere in this module
//! tree rather than commented here:
//!
//!   1. **The guest never gets the Tauri IPC bridge.** `policy::navigation_allowed`
//!      refuses every scheme that could make it a local origin, its label
//!      (`policy::guest_label`) sits outside every glob in
//!      `capabilities/default.json`, and that file is scoped by `webviews`
//!      rather than `windows` precisely so a child webview inside window `main`
//!      inherits nothing. See `policy.rs` and `capabilities.rs`.
//!   2. **Lock ordering.** `BrowserState::guests` is taken first and released
//!      before any `await` on a host; `reach::ForwardLeases` has its own mutex
//!      and is NEVER taken while `guests` is held.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Url};
use tokio::sync::{oneshot, Mutex};

#[cfg(test)]
mod capability_globs;
pub mod commands;
mod error;
mod history;
mod policy;
pub mod reach;
mod reach_url;
mod stub;

// `Cargo.toml` enables `tauri/unstable` unconditionally, so `Window::add_child`
// is in scope on every desktop build and the cfg here is the plain platform
// one. `stub` stays for any target that is neither — and for the unit tests,
// which assert it refuses by name rather than no-op'ing.
#[cfg(desktop)]
mod desktop;
#[cfg(mobile)]
mod mobile;

#[cfg(desktop)]
use desktop as imp;
#[cfg(mobile)]
use mobile as imp;
#[cfg(not(any(desktop, mobile)))]
use stub as imp;

pub use error::{BrowserError, BrowserErrorKind};
pub use policy::NavVerdict;

pub type GuestId = String;

/// The ONE guest today. The tab names the SURFACE, not the page — a second
/// guest is a map insert, not a redesign.
pub const BROWSER_GUEST_ID: &str = "browser";

/// How long a navigation may take before the pane says nothing answered.
const LOAD_TIMEOUT: Duration = Duration::from_secs(20);

/// How long to let a finished document settle before reading its identity back.
const SETTLE: Duration = Duration::from_millis(120);

/// A single eval's answer may not exceed this. The reader windows IN THE PAGE
/// precisely so it never comes close.
pub const EVAL_MAX_BYTES: usize = 1024 * 1024;

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

// Some variants are constructed only by the mobile adapters, which do not
// compile on a desktop build — this is a WIRE contract, not dead code.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum HostKind {
    ChildWebview,
    NativeView,
    None,
}

// Some variants are constructed only by the mobile adapters, which do not
// compile on a desktop build — this is a WIRE contract, not dead code.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum StoreKind {
    Own,
    Ephemeral,
    Shared,
}

// Some variants are constructed only by the mobile adapters, which do not
// compile on a desktop build — this is a WIRE contract, not dead code.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum HistorySource {
    Engine,
    Estimated,
}

// Some variants are constructed only by the mobile adapters, which do not
// compile on a desktop build — this is a WIRE contract, not dead code.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ConsoleSource {
    Push,
    Poll,
    None,
}

// Some variants are constructed only by the mobile adapters, which do not
// compile on a desktop build — this is a WIRE contract, not dead code.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum LoadErrorSource {
    Engine,
    Timeout,
}

// Some variants are constructed only by the mobile adapters, which do not
// compile on a desktop build — this is a WIRE contract, not dead code.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ActInjection {
    Dom,
    NativeInput,
}

/// What THIS build, on THIS platform, can actually do. Asked once at first need
/// and read everywhere — the UI never infers a capability from a platform
/// constant, and never from "the call did not throw" (rule 10).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserCapabilities {
    pub platform: String,
    pub host: HostKind,
    pub isolated_store: StoreKind,
    pub history: HistorySource,
    pub gestures: bool,
    pub console: ConsoleSource,
    pub devtools: bool,
    pub load_errors: LoadErrorSource,
    pub act: ActInjection,
    /// Human-readable degrades. Deliberately NOT localised: these are
    /// agent- and log-facing wire strings, the same rule that keeps
    /// `PREVIEW_ACT_UNSUPPORTED` out of `i18n/en.ts`. Anything the *user* reads
    /// is an i18n key in the pane.
    pub notes: Vec<String>,
}

/// LOGICAL pixels, in the host window's coordinate space.
#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GuestBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GuestState {
    pub id: GuestId,
    /// The live address the bar shows. NEVER redacted here — redaction belongs
    /// on the telemetry path (rule 34), not on the thing the user is reading.
    pub url: String,
    pub title: String,
    pub loading: bool,
    pub can_back: bool,
    pub can_forward: bool,
    pub history_source: HistorySource,
    pub visible: bool,
}

impl GuestState {
    fn new(id: GuestId, url: String, history_source: HistorySource) -> Self {
        Self {
            id,
            url,
            title: String::new(),
            loading: true,
            can_back: false,
            can_forward: false,
            history_source,
            visible: true,
        }
    }
}

// ---------------------------------------------------------------------------
// The adapter trait
// ---------------------------------------------------------------------------

/// One platform's way of owning a web page at a rect.
///
/// Deliberately NOT `async_trait`: every method here either dispatches to the
/// platform's main thread and returns, or hands back a `oneshot` the caller
/// awaits. That keeps a whole crate out of the dependency tree and keeps the
/// "which thread am I on" question in one place per adapter.
pub trait GuestHost: Send + Sync {
    fn navigate(&self, url: &Url) -> Result<(), BrowserError>;
    fn back(&self) -> Result<(), BrowserError>;
    fn forward(&self) -> Result<(), BrowserError>;
    fn reload(&self) -> Result<(), BrowserError>;
    fn stop(&self) -> Result<(), BrowserError>;
    fn set_bounds(&self, bounds: GuestBounds) -> Result<(), BrowserError>;
    /// Returns the RESULTING visibility, not `()` — rule 9.
    fn set_visible(&self, visible: bool) -> Result<bool, BrowserError>;
    /// Hands back the channel the engine's callback will fire on.
    fn eval(&self, js: &str) -> Result<oneshot::Receiver<String>, BrowserError>;
    fn clear_data(&self) -> Result<(), BrowserError>;
    fn open_devtools(&self) -> Result<bool, BrowserError>;
    fn close(&self) -> Result<(), BrowserError>;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

pub struct Guest {
    pub state: GuestState,
    host: Arc<dyn GuestHost>,
    /// Serialises eval per guest: a reader and an act call must not interleave
    /// scripts in one document.
    eval_lock: Arc<Mutex<()>>,
    history: history::HistoryModel,
    /// The window that owns this guest. Every event is `emit_to` that label —
    /// `app.emit` would make every tile window's host module believe it owns
    /// the guest.
    owner_label: String,
    /// Bumped on every load start, so a stale 20 s timeout task exits quietly.
    load_seq: u64,
}

#[derive(Default)]
pub struct BrowserState {
    guests: Mutex<HashMap<GuestId, Guest>>,
    pub leases: reach::ForwardLeases,
}

// ---------------------------------------------------------------------------
// Events (rule 23 — per-instance `{scheme}://{id}/{topic}`)
// ---------------------------------------------------------------------------

fn topic(id: &str, name: &str) -> String {
    format!("browser://{id}/{name}")
}

fn emit(app: &AppHandle, owner: &str, id: &str, name: &str, payload: impl Serialize + Clone) {
    let _ = app.emit_to(owner, &topic(id, name), payload);
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LoadEvent {
    phase: &'static str,
    url: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorEvent {
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<i32>,
    pub description: String,
    pub url: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClosedEvent {
    reason: &'static str,
}

/// A command the guest asked the host to run on its behalf, arriving through
/// the navigation guard (`policy::GUEST_COMMAND_SCHEME`). Fully untrusted.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CommandEvent {
    command: String,
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

pub fn capabilities(app: &AppHandle) -> BrowserCapabilities {
    imp::capabilities(app)
}

/// The platform string every adapter reports, so the descriptor and the OS
/// plugin never disagree.
fn platform_name() -> String {
    std::env::consts::OS.to_string()
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

impl BrowserState {
    /// Open (or re-navigate) the guest. Idempotent by design: the pane calls
    /// this on every mount, and a second URL must not build a second webview.
    pub async fn open(
        &self,
        app: &AppHandle,
        owner_label: &str,
        id: GuestId,
        url: &str,
        bounds: GuestBounds,
    ) -> Result<GuestState, BrowserError> {
        let parsed = parse_allowed(url)?;

        let mut guests = self.guests.lock().await;

        if let Some(guest) = guests.get_mut(&id) {
            guest.history.will_move(history::Move::Push);
            guest.host.set_bounds(bounds)?;
            guest.host.navigate(&parsed)?;
            guest.state.url = parsed.to_string();
            guest.state.loading = true;
            return Ok(guest.state.clone());
        }

        let caps = imp::capabilities(app);

        if caps.host == HostKind::None {
            return Err(BrowserError::unsupported());
        }

        let host = imp::build(app, owner_label, &id, &parsed, bounds)?;

        let guest = Guest {
            state: GuestState::new(id.clone(), parsed.to_string(), caps.history),
            host,
            eval_lock: Arc::new(Mutex::new(())),
            history: history::HistoryModel::default(),
            owner_label: owner_label.to_string(),
            load_seq: 0,
        };

        let state = guest.state.clone();
        guests.insert(id, guest);

        Ok(state)
    }

    async fn with_host<T>(
        &self,
        id: &str,
        f: impl FnOnce(&mut Guest) -> Result<T, BrowserError>,
    ) -> Result<T, BrowserError> {
        let mut guests = self.guests.lock().await;
        let guest = guests
            .get_mut(id)
            .ok_or_else(|| BrowserError::no_such_guest(id))?;

        f(guest)
    }

    #[allow(dead_code)]
    pub async fn state_of(&self, id: &str) -> Result<GuestState, BrowserError> {
        self.with_host(id, |g| Ok(g.state.clone())).await
    }

    pub async fn navigate(&self, id: &str, url: &str) -> Result<GuestState, BrowserError> {
        let parsed = parse_allowed(url)?;

        self.with_host(id, |g| {
            g.history.will_move(history::Move::Push);
            g.host.navigate(&parsed)?;
            g.state.url = parsed.to_string();
            g.state.loading = true;
            Ok(g.state.clone())
        })
        .await
    }

    pub async fn go(&self, id: &str, forward: bool) -> Result<GuestState, BrowserError> {
        self.with_host(id, |g| {
            g.history.will_move(if forward {
                history::Move::Forward
            } else {
                history::Move::Back
            });

            if forward {
                g.host.forward()?;
            } else {
                g.host.back()?;
            }

            g.state.loading = true;
            Ok(g.state.clone())
        })
        .await
    }

    pub async fn reload(&self, id: &str) -> Result<GuestState, BrowserError> {
        self.with_host(id, |g| {
            g.host.reload()?;
            g.state.loading = true;
            Ok(g.state.clone())
        })
        .await
    }

    pub async fn stop(&self, id: &str) -> Result<GuestState, BrowserError> {
        self.with_host(id, |g| {
            g.host.stop()?;
            g.state.loading = false;
            Ok(g.state.clone())
        })
        .await
    }

    pub async fn set_bounds(&self, id: &str, bounds: GuestBounds) -> Result<(), BrowserError> {
        self.with_host(id, |g| g.host.set_bounds(bounds)).await
    }

    pub async fn set_visible(&self, id: &str, visible: bool) -> Result<bool, BrowserError> {
        self.with_host(id, |g| {
            let now = g.host.set_visible(visible)?;
            g.state.visible = now;
            Ok(now)
        })
        .await
    }

    pub async fn clear_data(&self, id: &str) -> Result<(), BrowserError> {
        self.with_host(id, |g| g.host.clear_data()).await
    }

    pub async fn open_devtools(&self, id: &str) -> Result<bool, BrowserError> {
        self.with_host(id, |g| g.host.open_devtools()).await
    }

    pub async fn close(&self, app: &AppHandle, id: &str) -> Result<(), BrowserError> {
        let guest = self.guests.lock().await.remove(id);

        let Some(guest) = guest else {
            return Ok(());
        };

        let _ = guest.host.close();
        emit(
            app,
            &guest.owner_label,
            id,
            "closed",
            ClosedEvent { reason: "closed" },
        );

        Ok(())
    }

    /// The ONE eval door. Serialised per guest, bounded in time and in size.
    pub async fn eval(
        &self,
        id: &str,
        script: &str,
        timeout: Duration,
    ) -> Result<String, BrowserError> {
        // Take the host and the eval lock out of the map, then RELEASE the map:
        // an eval can take seconds and a bounds update must not wait on it.
        let (host, lock) = {
            let guests = self.guests.lock().await;
            let guest = guests
                .get(id)
                .ok_or_else(|| BrowserError::no_such_guest(id))?;
            (Arc::clone(&guest.host), Arc::clone(&guest.eval_lock))
        };

        let _serialised = lock.lock().await;
        let rx = host.eval(script)?;

        let answer = tokio::time::timeout(timeout, rx).await.map_err(|_| {
            BrowserError::new(
                BrowserErrorKind::EvalTimeout,
                "The page did not answer in time.",
            )
        })?;

        let answer = answer.map_err(|_| {
            BrowserError::new(
                BrowserErrorKind::EvalTimeout,
                "The page went away before it answered.",
            )
        })?;

        if answer.len() > EVAL_MAX_BYTES {
            return Err(BrowserError::new(
                BrowserErrorKind::EvalTooLarge,
                format!(
                    "The page returned {} bytes; the cap is {EVAL_MAX_BYTES}.",
                    answer.len()
                ),
            ));
        }

        Ok(answer)
    }
}

/// Parse and gate a URL before it ever reaches a host.
fn parse_allowed(raw: &str) -> Result<Url, BrowserError> {
    let url = Url::parse(raw.trim()).map_err(|e| {
        BrowserError::new(
            BrowserErrorKind::BlockedScheme,
            format!("{raw:?} is not an address: {e}"),
        )
    })?;

    match policy::navigation_allowed(&url) {
        NavVerdict::Allow => Ok(url),
        _ => Err(BrowserError::new(
            BrowserErrorKind::BlockedScheme,
            format!("The in-app browser will not open {:?} URLs.", url.scheme()),
        )),
    }
}

// ---------------------------------------------------------------------------
// The load / settle lifecycle, shared by every adapter
// ---------------------------------------------------------------------------

/// The identity probe read back after a document settles. Kept tiny on purpose:
/// this crosses IPC on every navigation.
const IDENTITY_PROBE: &str = "(()=>{try{return JSON.stringify({u:location.href,t:document.title,n:history.length,s:!!document.body})}catch(e){return '{}'}})()";

/// An adapter reports a load phase here rather than emitting itself, so the
/// timeout, the settle read and the history model live in ONE place instead of
/// three copies with three different bugs.
pub fn on_load(app: &AppHandle, id: &GuestId, started: bool, url: String) {
    let app = app.clone();
    let id = id.clone();

    tauri::async_runtime::spawn(async move {
        use tauri::Manager;

        let state = app.state::<BrowserState>();

        let (owner, seq) = {
            let mut guests = state.guests.lock().await;
            let Some(guest) = guests.get_mut(&id) else {
                return;
            };

            guest.state.loading = started;
            guest.state.url = url.clone();

            if started {
                guest.load_seq = guest.load_seq.wrapping_add(1);
            }

            (guest.owner_label.clone(), guest.load_seq)
        };

        emit(
            &app,
            &owner,
            &id,
            "load",
            LoadEvent {
                phase: if started { "started" } else { "finished" },
                url: url.clone(),
            },
        );

        if started {
            // A load with no `Finished` inside the budget is unreachable —
            // tauri gives us no engine-level error on desktop, so silence IS
            // the signal. A superseding `Started` bumps `load_seq` and this
            // exits quietly.
            let app = app.clone();
            let id = id.clone();

            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(LOAD_TIMEOUT).await;
                report_timeout(&app, &id, seq, url).await;
            });

            return;
        }

        tokio::time::sleep(SETTLE).await;
        settle(&app, &id).await;
    });
}

async fn report_timeout(app: &AppHandle, id: &GuestId, seq: u64, url: String) {
    use tauri::Manager;

    let state = app.state::<BrowserState>();
    let guests = state.guests.lock().await;

    let Some(guest) = guests.get(id) else {
        return;
    };

    if guest.load_seq != seq || !guest.state.loading {
        return;
    }

    let owner = guest.owner_label.clone();
    drop(guests);

    emit(
        app,
        &owner,
        id,
        "error",
        ErrorEvent {
            kind: "timeout",
            code: None,
            description: "Nothing answered within 20 seconds.".to_string(),
            url,
        },
    );
}

/// Read the settled document's identity back and publish the nav state.
pub async fn settle(app: &AppHandle, id: &GuestId) {
    use tauri::Manager;

    let state = app.state::<BrowserState>();

    let Ok(raw) = state.eval(id, IDENTITY_PROBE, Duration::from_secs(5)).await else {
        return;
    };

    // `eval_with_callback` hands back a JSON *value*; ours is a JSON string
    // containing JSON, so it unwraps twice.
    let probe: serde_json::Value = serde_json::from_str(&raw)
        .ok()
        .and_then(|v: serde_json::Value| match v {
            serde_json::Value::String(s) => serde_json::from_str(&s).ok(),
            other => Some(other),
        })
        .unwrap_or(serde_json::Value::Null);

    let mut guests = state.guests.lock().await;

    let Some(guest) = guests.get_mut(id) else {
        return;
    };

    if let Some(u) = probe.get("u").and_then(|v| v.as_str()) {
        guest.state.url = u.to_string();
    }

    guest.state.title = probe
        .get("t")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();

    let len = probe.get("n").and_then(|v| v.as_u64()).unwrap_or(1) as usize;
    let (can_back, can_forward) = guest.history.observe(len);

    guest.state.can_back = can_back;
    guest.state.can_forward = can_forward;
    guest.state.loading = false;

    let owner = guest.owner_label.clone();
    let published = guest.state.clone();
    drop(guests);

    emit(app, &owner, id, "nav", published);
}

/// An adapter that HAS engine-level history (Android/iOS) publishes it here
/// instead of going through the counted model. Kept on every target so the
/// contract has one shape.
#[allow(dead_code)]
pub async fn publish_engine_nav(
    app: &AppHandle,
    id: &GuestId,
    url: String,
    title: String,
    can_back: bool,
    can_forward: bool,
) {
    use tauri::Manager;

    let state = app.state::<BrowserState>();
    let mut guests = state.guests.lock().await;

    let Some(guest) = guests.get_mut(id) else {
        return;
    };

    guest.state.url = url;
    guest.state.title = title;
    guest.state.can_back = can_back;
    guest.state.can_forward = can_forward;
    guest.state.loading = false;

    let owner = guest.owner_label.clone();
    let published = guest.state.clone();
    drop(guests);

    emit(app, &owner, id, "nav", published);
}

/// An adapter reports an engine-level load failure here.
pub fn on_error(app: &AppHandle, id: &GuestId, event: ErrorEvent) {
    let app = app.clone();
    let id = id.clone();

    tauri::async_runtime::spawn(async move {
        use tauri::Manager;

        let state = app.state::<BrowserState>();
        let owner = {
            let guests = state.guests.lock().await;
            match guests.get(&id) {
                Some(guest) => guest.owner_label.clone(),
                None => return,
            }
        };

        emit(&app, &owner, &id, "error", event);
    });
}

/// A push-capable adapter (Android's `WebChromeClient`) delivers console lines
/// here. Poll-only platforms drain through `browser_eval` instead.
#[allow(dead_code)]
pub fn on_console(app: &AppHandle, id: &GuestId, entries: serde_json::Value) {
    let app = app.clone();
    let id = id.clone();

    tauri::async_runtime::spawn(async move {
        use tauri::Manager;

        let state = app.state::<BrowserState>();
        let owner = {
            let guests = state.guests.lock().await;
            match guests.get(&id) {
                Some(guest) => guest.owner_label.clone(),
                None => return,
            }
        };

        let _ = app.emit_to(&owner, &topic(&id, "console"), entries);
    });
}

/// The guest asked the host for something through the navigation guard.
pub fn on_guest_command(app: &AppHandle, id: &GuestId, command: String) {
    let app = app.clone();
    let id = id.clone();

    tauri::async_runtime::spawn(async move {
        use tauri::Manager;

        let state = app.state::<BrowserState>();
        let owner = {
            let guests = state.guests.lock().await;
            match guests.get(&id) {
                Some(guest) => guest.owner_label.clone(),
                None => return,
            }
        };

        emit(&app, &owner, &id, "command", CommandEvent { command });
    });
}

/// Drop every forward lease for one SSH scope. Called from `ssh_disconnect` and
/// from the unexpected-death path, so a new host never inherits a tunnel into
/// the old one.
pub async fn drop_reach_scope(app: &AppHandle, scope: &str) {
    use tauri::Manager;

    let Some(state) = app.try_state::<BrowserState>() else {
        return;
    };

    let closed = state.leases.drop_scope(scope).await;

    if closed > 0 {
        log::info!("browser: dropped {closed} forward lease(s) for scope {scope:?}");
    }
}

/// A window went away: drop the guests it owned, and every forward lease with
/// them. Called from `lib.rs`'s `WindowEvent::Destroyed` arm, beside
/// `reap_window_sockets`.
pub fn reap_window(app: &AppHandle, label: &str) {
    let app = app.clone();
    let label = label.to_string();

    tauri::async_runtime::spawn(async move {
        use tauri::Manager;

        let state = app.state::<BrowserState>();
        let mut guests = state.guests.lock().await;

        guests.retain(|_, guest| {
            if guest.owner_label != label {
                return true;
            }

            let _ = guest.host.close();
            false
        });
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The one host that needs no display server. Everything the state machine
    /// does above is exercised through this.
    struct FakeHost {
        answer: String,
    }

    impl GuestHost for FakeHost {
        fn navigate(&self, _url: &Url) -> Result<(), BrowserError> {
            Ok(())
        }
        fn back(&self) -> Result<(), BrowserError> {
            Ok(())
        }
        fn forward(&self) -> Result<(), BrowserError> {
            Ok(())
        }
        fn reload(&self) -> Result<(), BrowserError> {
            Ok(())
        }
        fn stop(&self) -> Result<(), BrowserError> {
            Ok(())
        }
        fn set_bounds(&self, _bounds: GuestBounds) -> Result<(), BrowserError> {
            Ok(())
        }
        fn set_visible(&self, visible: bool) -> Result<bool, BrowserError> {
            Ok(visible)
        }
        fn eval(&self, _js: &str) -> Result<oneshot::Receiver<String>, BrowserError> {
            let (tx, rx) = oneshot::channel();
            let _ = tx.send(self.answer.clone());
            Ok(rx)
        }
        fn clear_data(&self) -> Result<(), BrowserError> {
            Ok(())
        }
        fn open_devtools(&self) -> Result<bool, BrowserError> {
            Ok(false)
        }
        fn close(&self) -> Result<(), BrowserError> {
            Ok(())
        }
    }

    fn fake_guest(answer: &str) -> Guest {
        Guest {
            state: GuestState::new(
                BROWSER_GUEST_ID.to_string(),
                "about:blank".into(),
                HistorySource::Estimated,
            ),
            host: Arc::new(FakeHost {
                answer: answer.to_string(),
            }),
            eval_lock: Arc::new(Mutex::new(())),
            history: history::HistoryModel::default(),
            owner_label: "main".into(),
            load_seq: 0,
        }
    }

    #[tokio::test]
    async fn an_unknown_guest_is_refused_by_name() {
        let state = BrowserState::default();
        let err = state
            .navigate("nope", "https://example.com")
            .await
            .unwrap_err();

        assert_eq!(err.kind, BrowserErrorKind::NoSuchGuest);
    }

    #[tokio::test]
    async fn a_refused_scheme_never_reaches_a_host() {
        let state = BrowserState::default();
        state
            .guests
            .lock()
            .await
            .insert(BROWSER_GUEST_ID.to_string(), fake_guest("\"\""));

        for raw in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "tauri://localhost/",
        ] {
            let err = state.navigate(BROWSER_GUEST_ID, raw).await.unwrap_err();
            assert_eq!(err.kind, BrowserErrorKind::BlockedScheme, "{raw}");
        }
    }

    #[tokio::test]
    async fn set_visible_reports_the_resulting_state() {
        let state = BrowserState::default();
        state
            .guests
            .lock()
            .await
            .insert(BROWSER_GUEST_ID.to_string(), fake_guest("\"\""));

        assert!(!state.set_visible(BROWSER_GUEST_ID, false).await.unwrap());
        assert_eq!(
            state.state_of(BROWSER_GUEST_ID).await.unwrap().visible,
            false
        );
    }

    #[tokio::test]
    async fn an_oversized_answer_is_refused_rather_than_forwarded() {
        let state = BrowserState::default();
        let huge = "x".repeat(EVAL_MAX_BYTES + 1);
        state
            .guests
            .lock()
            .await
            .insert(BROWSER_GUEST_ID.to_string(), fake_guest(&huge));

        let err = state
            .eval(BROWSER_GUEST_ID, "1", Duration::from_secs(1))
            .await
            .unwrap_err();

        assert_eq!(err.kind, BrowserErrorKind::EvalTooLarge);
    }

    #[tokio::test]
    async fn an_eval_that_never_answers_times_out_instead_of_hanging() {
        struct Silent;

        impl GuestHost for Silent {
            fn navigate(&self, _url: &Url) -> Result<(), BrowserError> {
                Ok(())
            }
            fn back(&self) -> Result<(), BrowserError> {
                Ok(())
            }
            fn forward(&self) -> Result<(), BrowserError> {
                Ok(())
            }
            fn reload(&self) -> Result<(), BrowserError> {
                Ok(())
            }
            fn stop(&self) -> Result<(), BrowserError> {
                Ok(())
            }
            fn set_bounds(&self, _bounds: GuestBounds) -> Result<(), BrowserError> {
                Ok(())
            }
            fn set_visible(&self, visible: bool) -> Result<bool, BrowserError> {
                Ok(visible)
            }
            fn eval(&self, _js: &str) -> Result<oneshot::Receiver<String>, BrowserError> {
                // Drop the sender on the floor, exactly as a dead page does.
                let (_tx, rx) = oneshot::channel();
                Ok(rx)
            }
            fn clear_data(&self) -> Result<(), BrowserError> {
                Ok(())
            }
            fn open_devtools(&self) -> Result<bool, BrowserError> {
                Ok(false)
            }
            fn close(&self) -> Result<(), BrowserError> {
                Ok(())
            }
        }

        let state = BrowserState::default();
        let mut guest = fake_guest("\"\"");
        guest.host = Arc::new(Silent);
        state
            .guests
            .lock()
            .await
            .insert(BROWSER_GUEST_ID.to_string(), guest);

        let err = state
            .eval(BROWSER_GUEST_ID, "1", Duration::from_millis(20))
            .await
            .unwrap_err();

        assert_eq!(err.kind, BrowserErrorKind::EvalTimeout);
    }

    #[test]
    fn the_event_topics_are_per_instance() {
        assert_eq!(topic("browser", "nav"), "browser://browser/nav");
    }

    #[test]
    fn the_capability_descriptor_serialises_camel_case() {
        let caps = BrowserCapabilities {
            platform: "linux".into(),
            host: HostKind::ChildWebview,
            isolated_store: StoreKind::Own,
            history: HistorySource::Estimated,
            gestures: false,
            console: ConsoleSource::Poll,
            devtools: true,
            load_errors: LoadErrorSource::Timeout,
            act: ActInjection::Dom,
            notes: vec![],
        };

        let json = serde_json::to_string(&caps).expect("serialise");

        assert!(json.contains("\"isolatedStore\":\"own\""), "{json}");
        assert!(json.contains("\"host\":\"child-webview\""), "{json}");
        assert!(json.contains("\"loadErrors\":\"timeout\""), "{json}");
    }

    #[test]
    fn the_stub_refuses_every_method_by_name() {
        let host = stub::NoHost;

        assert_eq!(
            host.reload().unwrap_err().kind,
            BrowserErrorKind::UnsupportedPlatform
        );
        assert_eq!(
            host.set_visible(true).unwrap_err().kind,
            BrowserErrorKind::UnsupportedPlatform
        );
        assert_eq!(
            host.eval("1").unwrap_err().kind,
            BrowserErrorKind::UnsupportedPlatform
        );
    }
}
