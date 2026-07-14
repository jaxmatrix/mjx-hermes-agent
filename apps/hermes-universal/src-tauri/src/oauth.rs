//! Connection-level gateway OAuth (Track D3).
//!
//! Desktop (Electron) captures the gateway's HttpOnly session cookie by binding
//! a `BrowserWindow` to a persistent session partition and polling the shared
//! cookie jar. Tauri has no automatic sharing between a webview and reqwest, and
//! the gateway's OAuth `redirect_uri` is ALWAYS a same-origin `{base}/auth/callback`
//! https URL (never a custom scheme — see `hermes_cli/dashboard_auth/routes.py`),
//! so a `hermes://` deep-link callback is impossible.
//!
//! Instead we drive both gateway legs through reqwest (so every Set-Cookie lands
//! in the shared jar automatically) and use a webview only for the interactive
//! IDP portion:
//!
//!   1. reqwest `GET {base}/auth/login?provider=X` with redirects DISABLED →
//!      captures the `hermes_session_pkce` cookie and reads the 302 `Location`
//!      (the IDP authorize URL).
//!   2. Open a `WebviewWindow` at the authorize URL with an `on_navigation`
//!      guard. The user authenticates at the IDP.
//!   3. The IDP 302s to `{base}/auth/callback?code&state`. The guard matches that
//!      prefix, returns `false` to CANCEL the load (so the single-use `code` is
//!      not consumed by the webview), captures the URL, and closes the window.
//!   4. reqwest `GET {base}/auth/callback?...` — reqwest still holds the PKCE
//!      cookie, so the gateway exchanges the code and sets `hermes_session_at/_rt`
//!      into the shared jar.
//!
//! After this, `POST /api/auth/ws-ticket` (driven from JS via `http_request`)
//! is authenticated by the same jar — no cookie ever crosses the webview↔reqwest
//! boundary.

use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Manager, State, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tokio::sync::oneshot;

use crate::transport::TransportState;

/// The single label for the interactive sign-in window. Reused (closed + rebuilt)
/// across attempts so a stale window never lingers.
const OAUTH_WINDOW_LABEL: &str = "hermes-oauth";

fn normalize_base(raw: &str) -> String {
    raw.trim().trim_end_matches('/').to_string()
}

/// Run the interactive gateway OAuth flow. On success the session cookies live in
/// the shared reqwest jar; the caller (JS) then connects the gateway normally and
/// the ws-ticket mint is authenticated.
#[tauri::command]
pub async fn oauth_login(
    app: AppHandle,
    state: State<'_, TransportState>,
    base: String,
    provider: Option<String>,
) -> Result<(), String> {
    let base = normalize_base(&base);
    let provider = provider.unwrap_or_else(|| "nous".to_string());

    // 1. Bootstrap /auth/login with redirects OFF: land the PKCE cookie in the
    //    shared jar and read the IDP authorize URL from the 302 Location.
    let login_url = format!("{base}/auth/login?provider={provider}");
    let resp = state
        .no_redirect_client()
        .get(&login_url)
        .header(reqwest::header::ORIGIN, &base)
        .send()
        .await
        .map_err(|e| format!("auth/login request failed: {e}"))?;

    if !resp.status().is_redirection() {
        return Err(format!(
            "expected a 302 redirect from /auth/login, got HTTP {}",
            resp.status()
        ));
    }
    let authorize = resp
        .headers()
        .get(reqwest::header::LOCATION)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| "no Location header on the /auth/login redirect".to_string())?
        .to_string();

    // A password-backed provider redirects back to the local /login HTML page
    // rather than an external IDP — that path belongs to password-login, not here.
    let callback_prefix = format!("{base}/auth/callback");
    if authorize.starts_with(&format!("{base}/login")) {
        return Err("This provider uses password login, not interactive OAuth".to_string());
    }

    let authorize_url =
        Url::parse(&authorize).map_err(|e| format!("invalid authorize URL {authorize:?}: {e}"))?;

    // 2. Open the authorize URL in a webview and intercept the callback. The
    //    oneshot carries either the intercepted callback URL or a "window closed"
    //    error; it is single-use, hence the Option guard shared by both handlers.
    let (tx, rx) = oneshot::channel::<Result<String, String>>();
    let tx = Arc::new(Mutex::new(Some(tx)));

    let tx_nav = tx.clone();
    let tx_close = tx.clone();
    let app_build = app.clone();

    // Window creation must happen on the main thread (gtk/WKWebView requirement);
    // run_on_main_thread queues it and returns immediately, then we await rx.
    // FIXME(D3): a second WebviewWindow is device-verified on desktop only; Tauri
    // mobile multi-webview support is limited — verify the interactive IDP window
    // opens on Android/iOS, else fall back to an in-page auth webview route.
    app.run_on_main_thread(move || {
        // Drop any stale window from a previous attempt first.
        if let Some(existing) = app_build.get_webview_window(OAUTH_WINDOW_LABEL) {
            let _ = existing.close();
        }

        let build = WebviewWindowBuilder::new(
            &app_build,
            OAUTH_WINDOW_LABEL,
            WebviewUrl::External(authorize_url),
        )
        .title("Sign in to Hermes")
        .inner_size(520.0, 720.0)
        .on_navigation(move |url| {
            if url.as_str().starts_with(&callback_prefix) {
                if let Some(tx) = tx_nav.lock().ok().and_then(|mut g| g.take()) {
                    let _ = tx.send(Ok(url.to_string()));
                }
                // Cancel the load so the webview never consumes the single-use code.
                return false;
            }
            true
        })
        .build();

        match build {
            Ok(win) => {
                win.on_window_event(move |event| {
                    if matches!(
                        event,
                        WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed
                    ) {
                        if let Some(tx) = tx_close.lock().ok().and_then(|mut g| g.take()) {
                            let _ = tx.send(Err(
                                "Sign-in window was closed before completing".to_string()
                            ));
                        }
                    }
                });
            }
            Err(e) => {
                if let Some(tx) = tx_close.lock().ok().and_then(|mut g| g.take()) {
                    let _ = tx.send(Err(format!("could not open sign-in window: {e}")));
                }
            }
        }
    })
    .map_err(|e| format!("failed to schedule sign-in window: {e}"))?;

    let callback_url = rx
        .await
        .map_err(|_| "sign-in was cancelled".to_string())??;

    // Close the interactive window now that we have the callback.
    if let Some(win) = app.get_webview_window(OAUTH_WINDOW_LABEL) {
        let _ = win.close();
    }

    // 3. Complete the exchange via reqwest (redirects OFF is fine — the 302's
    //    Set-Cookie is applied to the shared jar before the response returns).
    let done = state
        .no_redirect_client()
        .get(&callback_url)
        .header(reqwest::header::ORIGIN, &base)
        .send()
        .await
        .map_err(|e| format!("auth/callback request failed: {e}"))?;

    let status = done.status();
    // Success is a 302 back to the app; a 4xx means the code/state was rejected.
    if !(status.is_redirection() || status.is_success()) {
        let body = done.text().await.unwrap_or_default();
        return Err(format!("OAuth callback rejected (HTTP {status}): {body}"));
    }

    Ok(())
}
