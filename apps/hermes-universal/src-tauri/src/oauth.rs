//! Connection-level gateway OAuth (Track D3).
//!
//! Mirrors Hermes desktop (Electron), which binds an OAuth `BrowserWindow` to a
//! persistent session partition, runs the WHOLE login there, and polls that jar
//! for the session cookie. Tauri doesn't auto-share cookies between a webview and
//! reqwest, and the gateway's `redirect_uri` is always a same-origin
//! `{base}/auth/callback` https URL (never a custom scheme), so a deep-link
//! callback is impossible — and intercepting the callback to replay it via reqwest
//! is fragile on WebKitGTK (the redirect chain doesn't reliably fire
//! `on_navigation`/`on_page_load`).
//!
//! So we let the interactive webview complete the ENTIRE cascade itself
//! (`/auth/login` → IDP → `/auth/callback` → dashboard), which lands the session
//! cookies (`hermes_session_at`/`_rt`, HttpOnly) in the WEBVIEW's cookie jar, then:
//!
//!   1. Open a `WebviewWindow` at `{base}/auth/login?provider=X` (sets the
//!      webview's own PKCE cookie and goes straight to the provider).
//!   2. Poll `webview.cookies_for_url({base})` — on WebKitGTK this reads the
//!      libsoup/WebKit cookie manager (HttpOnly cookies included, unlike
//!      `document.cookie`) — until the session cookie appears.
//!   3. Import those cookies into the SHARED reqwest jar via `insert_raw`, so the
//!      ws-ticket mint (driven from JS via `http_request`) is authenticated. Then
//!      close the window.
//!
//! A timeout backstops the poll so a missed / abandoned login can't hang connect().

use serde::Serialize;
use tauri::{AppHandle, Manager, State, Url, WebviewUrl, WebviewWindowBuilder};
use tokio::sync::oneshot;

use crate::transport::TransportState;

/// The single label for the interactive sign-in window. Reused (closed + rebuilt)
/// across attempts so a stale window never lingers.
const OAUTH_WINDOW_LABEL: &str = "hermes-oauth";

/// How long to wait for the interactive login before giving up.
const OAUTH_TIMEOUT_SECS: u64 = 300;

fn normalize_base(raw: &str) -> String {
    raw.trim().trim_end_matches('/').to_string()
}

/// A completed gateway login is signalled by the presence of the access- or
/// refresh-token session cookie. The gateway may prefix it (`__Host-`/`__Secure-`),
/// so match by suffix — mirrors desktop's AT/RT cookie variants.
fn is_session_cookie(name: &str) -> bool {
    name.ends_with("hermes_session_at") || name.ends_with("hermes_session_rt")
}

/// Run the interactive gateway OAuth flow. The webview completes the whole login;
/// we then copy its session cookies into the shared reqwest jar so the caller (JS)
/// can connect the gateway normally and the ws-ticket mint is authenticated.
#[tauri::command]
pub async fn oauth_login(
    app: AppHandle,
    state: State<'_, TransportState>,
    base: String,
    provider: Option<String>,
) -> Result<(), String> {
    let base = normalize_base(&base);
    let provider = provider.unwrap_or_else(|| "nous".to_string());
    let base_url = Url::parse(&base).map_err(|e| format!("invalid gateway URL {base:?}: {e}"))?;

    // Load the gateway's own login entry point in the webview (not the IDP
    // directly): it sets the webview's PKCE cookie and 302s straight to the
    // provider, then runs the full cascade back to the dashboard — all inside the
    // webview's cookie jar.
    let login_url = format!("{base}/auth/login?provider={provider}");
    let login_url =
        Url::parse(&login_url).map_err(|e| format!("invalid login URL {login_url:?}: {e}"))?;

    // Build the window on the main thread (gtk/WKWebView requirement). A oneshot
    // carries the build result back so a failure surfaces instead of a dead poll.
    // FIXME(D3): Tauri mobile multi-webview support is limited — verify the sign-in
    // window opens on Android/iOS, else fall back to an in-page auth webview route.
    let (build_tx, build_rx) = oneshot::channel::<Result<(), String>>();
    let app_build = app.clone();
    app.run_on_main_thread(move || {
        // Drop any stale window from a previous attempt first.
        if let Some(existing) = app_build.get_webview_window(OAUTH_WINDOW_LABEL) {
            let _ = existing.close();
        }
        let build =
            WebviewWindowBuilder::new(&app_build, OAUTH_WINDOW_LABEL, WebviewUrl::External(login_url))
                .title("Sign in to Hermes")
                .inner_size(520.0, 720.0)
                .build();
        let _ = build_tx.send(
            build
                .map(|_| ())
                .map_err(|e| format!("could not open sign-in window: {e}")),
        );
    })
    .map_err(|e| format!("failed to schedule sign-in window: {e}"))?;

    build_rx
        .await
        .map_err(|_| "failed to open sign-in window".to_string())??;

    // Poll the webview's cookie jar until a VALID session lands (login done), the
    // user closes the window, or we time out.
    let outcome = tokio::time::timeout(std::time::Duration::from_secs(OAUTH_TIMEOUT_SECS), async {
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;

            let Some(win) = app.get_webview_window(OAUTH_WINDOW_LABEL) else {
                return Err("Sign-in window was closed before completing".to_string());
            };

            // cookies_for_url reads the platform cookie store (HttpOnly included on
            // WebKitGTK); safe to call from this async (off-main) context on desktop.
            // Transient errors just retry on the next tick.
            let Ok(cookies) = win.cookies_for_url(base_url.clone()) else {
                continue;
            };
            if !cookies
                .iter()
                .any(|c| is_session_cookie(c.name()) && !c.value().is_empty())
            {
                continue;
            }

            // Merge the gateway's cookies (AT/RT/CSRF) into the shared reqwest jar so
            // the ws-ticket mint is authenticated. base_url is http(s), so HttpOnly
            // cookies insert cleanly.
            {
                let mut store = state
                    .cookies()
                    .lock()
                    .map_err(|_| "cookie jar poisoned".to_string())?;
                for cookie in &cookies {
                    let _ = store.insert_raw(cookie, &base_url);
                }
            }

            // Confirm the imported session is actually live server-side before we
            // declare success — the webview jar can hold a STALE cookie from a prior
            // login (sign-out only clears the reqwest jar), which we must ignore and
            // keep waiting past. `/api/auth/me` is the same probe oauth_status uses.
            let me = state
                .client()
                .get(format!("{base}/api/auth/me"))
                .header(reqwest::header::ORIGIN, &base)
                .send()
                .await;
            if matches!(me, Ok(ref resp) if resp.status().is_success()) {
                return Ok(());
            }
        }
    })
    .await;

    // Close the interactive window either way.
    if let Some(win) = app.get_webview_window(OAUTH_WINDOW_LABEL) {
        let _ = win.close();
    }

    match outcome {
        Ok(inner) => inner,
        Err(_) => Err("Sign-in timed out before completing".to_string()),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OauthStatus {
    signed_in: bool,
    email: Option<String>,
    display_name: Option<String>,
}

/// Whether the shared jar currently holds a live gateway session, via the
/// auth-required `GET /api/auth/me` probe (401 ⇒ signed out). Used on connect to
/// decide between a silent reconnect and re-opening the sign-in window.
#[tauri::command]
pub async fn oauth_status(
    state: State<'_, TransportState>,
    base: String,
) -> Result<OauthStatus, String> {
    let base = normalize_base(&base);
    let resp = state
        .client()
        .get(format!("{base}/api/auth/me"))
        .header(reqwest::header::ORIGIN, &base)
        .send()
        .await
        .map_err(|e| format!("auth/me request failed: {e}"))?;

    if !resp.status().is_success() {
        return Ok(OauthStatus {
            signed_in: false,
            email: None,
            display_name: None,
        });
    }

    let body: serde_json::Value = resp.json().await.unwrap_or(serde_json::Value::Null);
    Ok(OauthStatus {
        signed_in: true,
        email: body
            .get("email")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        display_name: body
            .get("display_name")
            .and_then(|v| v.as_str())
            .map(str::to_string),
    })
}

/// Sign out of the gateway session. `POST /auth/logout` revokes the refresh token
/// server-side and responds with max-age=0 Set-Cookie headers, which reqwest's
/// shared cookie jar applies — clearing the local session in the same round trip.
#[tauri::command]
pub async fn oauth_logout(
    state: State<'_, TransportState>,
    base: String,
) -> Result<(), String> {
    let base = normalize_base(&base);
    // redirects OFF: the logout 302 -> /login is irrelevant; we only need the
    // clearing Set-Cookie on the 302 response itself.
    state
        .no_redirect_client()
        .post(format!("{base}/auth/logout"))
        .header(reqwest::header::ORIGIN, &base)
        .send()
        .await
        .map_err(|e| format!("auth/logout request failed: {e}"))?;
    Ok(())
}
