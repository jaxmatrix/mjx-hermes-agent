//! Nous Cloud / Portal (Privy) integration (Track E4).
//!
//! Cloud mode discovers agents from the Nous portal and connects to the chosen
//! agent's gateway. The portal session is a Privy cookie held in a dedicated,
//! persistent portal webview (its own `data_directory`), mirroring desktop's
//! `persist:hermes-remote-oauth` partition. E4.a covers login + status; E4.b
//! bridges the portal cookie into reqwest to call `/api/agents`; E4.c does the
//! silent per-agent SSO.
//!
//! FIXME(E4): `cookies_for_url()` returns an empty Vec on Android and the Privy
//! cookie is HttpOnly (so JS can't read it either) — the reqwest cookie bridge
//! can't authenticate portal calls on Android. Cloud is desktop-working; the
//! Android fallback (an eval'd fetch inside the portal webview) is deferred.

use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::webview::cookie::Cookie;
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder};

const PORTAL_WINDOW_LABEL: &str = "hermes-portal";
const DEFAULT_PORTAL: &str = "https://portal.nousresearch.com";

/// Portal base URL — env-overridable like desktop (`HERMES_PORTAL_BASE_URL` /
/// `NOUS_PORTAL_BASE_URL`), trailing slash stripped.
pub fn portal_base() -> String {
    std::env::var("HERMES_PORTAL_BASE_URL")
        .or_else(|_| std::env::var("NOUS_PORTAL_BASE_URL"))
        .unwrap_or_else(|_| DEFAULT_PORTAL.to_string())
        .trim_end_matches('/')
        .to_string()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortalStatus {
    signed_in: bool,
    portal_base_url: String,
}

/// Privy portal session cookie names (bare + prefixed variants), from desktop
/// `connection-config.ts`.
pub fn has_privy_cookie(cookies: &[Cookie<'static>]) -> bool {
    cookies.iter().any(|c| {
        matches!(
            c.name(),
            "privy-token" | "__Host-privy-token" | "__Secure-privy-token" | "privy-session"
        )
    })
}

fn portal_data_dir(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("portal-webview"))
}

/// Build the persistent portal webview (its own data_directory so the Privy
/// session survives restarts and is shared with the discovery/SSO calls).
fn build_portal_window(app: &AppHandle, url: Url, visible: bool) -> tauri::Result<()> {
    let mut builder = WebviewWindowBuilder::new(app, PORTAL_WINDOW_LABEL, WebviewUrl::External(url))
        .title("Nous Portal")
        .inner_size(520.0, 720.0)
        .visible(visible);
    if let Some(dir) = portal_data_dir(app) {
        builder = builder.data_directory(dir);
    }
    builder.build().map(|_| ())
}

/// Read the portal webview's cookies for the portal origin. Returns false when no
/// webview exists yet. FIXME(E4): empty on Android (see module note).
fn portal_signed_in(app: &AppHandle, portal_url: &Url) -> bool {
    app.get_webview_window(PORTAL_WINDOW_LABEL)
        .and_then(|w| w.cookies_for_url(portal_url.clone()).ok())
        .map(|c| has_privy_cookie(&c))
        .unwrap_or(false)
}

/// Interactive portal sign-in: open the portal login page and wait until the
/// Privy session cookie appears, then hide the window (its data_directory keeps
/// the session for discovery + agent SSO).
#[tauri::command]
pub async fn portal_login(app: AppHandle) -> Result<PortalStatus, String> {
    let base = portal_base();
    let login_url =
        Url::parse(&format!("{base}/login")).map_err(|e| format!("bad portal URL: {e}"))?;
    let portal_url = Url::parse(&base).map_err(|e| format!("bad portal URL: {e}"))?;

    // (Re)create the visible portal window on the main thread.
    let app_build = app.clone();
    app.run_on_main_thread(move || {
        if let Some(existing) = app_build.get_webview_window(PORTAL_WINDOW_LABEL) {
            let _ = existing.close();
        }
        let _ = build_portal_window(&app_build, login_url, true);
    })
    .map_err(|e| format!("failed to open portal window: {e}"))?;

    // Poll the portal cookie jar (like desktop's 750ms poll) until signed in or
    // the window is closed / we time out.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(300);
    loop {
        tokio::time::sleep(Duration::from_millis(750)).await;
        if app.get_webview_window(PORTAL_WINDOW_LABEL).is_none() {
            return Err("Portal sign-in window was closed before completing".to_string());
        }
        if portal_signed_in(&app, &portal_url) {
            let app_hide = app.clone();
            let _ = app.run_on_main_thread(move || {
                if let Some(w) = app_hide.get_webview_window(PORTAL_WINDOW_LABEL) {
                    let _ = w.hide();
                }
            });
            return Ok(PortalStatus { signed_in: true, portal_base_url: base });
        }
        if tokio::time::Instant::now() >= deadline {
            return Err("Portal sign-in timed out".to_string());
        }
    }
}

// ---------------------------------------------------------------------------
// E4.b — agent discovery via the reqwest cookie bridge.
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudAgent {
    id: String,
    name: String,
    status: String,
    dashboard_url: Option<String>,
    dashboard_gateway_state: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudOrg {
    id: String,
    slug: Option<String>,
    name: String,
    is_personal: bool,
    role: String,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DiscoverResult {
    agents: Vec<CloudAgent>,
    org: Option<CloudOrg>,
    /// Present (with `needs_org_selection`) when the portal wants an org chosen.
    orgs: Vec<CloudOrg>,
    needs_login: bool,
    needs_org_selection: bool,
}

fn parse_agent(v: &Value) -> Option<CloudAgent> {
    Some(CloudAgent {
        id: v.get("id")?.as_str()?.to_string(),
        name: v.get("name").and_then(Value::as_str).unwrap_or("").to_string(),
        status: v.get("status").and_then(Value::as_str).unwrap_or("unknown").to_string(),
        dashboard_url: v.get("dashboardUrl").and_then(Value::as_str).map(str::to_string),
        dashboard_gateway_state: v
            .get("dashboardGatewayState")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string(),
    })
}

fn parse_org(v: &Value) -> Option<CloudOrg> {
    Some(CloudOrg {
        id: v.get("id")?.as_str()?.to_string(),
        slug: v.get("slug").and_then(Value::as_str).map(str::to_string),
        name: v.get("name").and_then(Value::as_str).unwrap_or("").to_string(),
        is_personal: v.get("isPersonal").and_then(Value::as_bool).unwrap_or(false),
        role: v.get("role").and_then(Value::as_str).unwrap_or("MEMBER").to_string(),
    })
}

fn parse_orgs(v: &Value) -> Vec<CloudOrg> {
    v.get("orgs")
        .and_then(Value::as_array)
        .map(|arr| arr.iter().filter_map(parse_org).collect())
        .unwrap_or_default()
}

/// Discover the cloud agents visible to the signed-in portal user. Bridges the
/// portal webview's Privy cookie into a reqwest request (the portal is a
/// different origin from any gateway, so we send an explicit Cookie header rather
/// than pollute the shared gateway jar). 401 → needs re-login; 409 → the user
/// belongs to multiple orgs and must pick one.
#[tauri::command]
pub async fn portal_discover_agents(
    app: AppHandle,
    org: Option<String>,
) -> Result<DiscoverResult, String> {
    let base = portal_base();
    let portal_url = Url::parse(&base).map_err(|e| format!("bad portal URL: {e}"))?;

    // Pull the portal cookies from the (persistent) portal webview.
    let cookies = app
        .get_webview_window(PORTAL_WINDOW_LABEL)
        .and_then(|w| w.cookies_for_url(portal_url).ok())
        .unwrap_or_default();
    if !has_privy_cookie(&cookies) {
        return Ok(DiscoverResult { needs_login: true, ..Default::default() });
    }
    let cookie_header = cookies
        .iter()
        .map(|c| format!("{}={}", c.name(), c.value()))
        .collect::<Vec<_>>()
        .join("; ");

    let mut url = format!("{base}/api/agents");
    if let Some(o) = org.as_deref().filter(|o| !o.is_empty()) {
        url = format!("{url}?org={o}");
    }

    let resp = reqwest::Client::new()
        .get(&url)
        .header(reqwest::header::COOKIE, cookie_header)
        .header(reqwest::header::ORIGIN, &base)
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("agent discovery request failed: {e}"))?;

    let status = resp.status();
    if status.as_u16() == 401 {
        return Ok(DiscoverResult { needs_login: true, ..Default::default() });
    }
    let body: Value = resp.json().await.unwrap_or(Value::Null);
    if status.as_u16() == 409 {
        return Ok(DiscoverResult {
            needs_org_selection: true,
            orgs: parse_orgs(&body),
            ..Default::default()
        });
    }
    if !status.is_success() {
        return Err(format!("agent discovery failed (HTTP {status})"));
    }

    let agents = body
        .get("agents")
        .and_then(Value::as_array)
        .map(|arr| arr.iter().filter_map(parse_agent).collect())
        .unwrap_or_default();
    let org = body.get("org").and_then(parse_org);
    Ok(DiscoverResult { agents, org, ..Default::default() })
}

/// Whether a live portal session exists, without prompting. Ensures a hidden
/// portal webview exists (to hold/read the persisted session), then reads its
/// cookies.
#[tauri::command]
pub async fn portal_status(app: AppHandle) -> Result<PortalStatus, String> {
    let base = portal_base();
    let portal_url = Url::parse(&base).map_err(|e| format!("bad portal URL: {e}"))?;

    if app.get_webview_window(PORTAL_WINDOW_LABEL).is_none() {
        let app_build = app.clone();
        let url = portal_url.clone();
        app.run_on_main_thread(move || {
            let _ = build_portal_window(&app_build, url, false);
        })
        .map_err(|e| format!("failed to open portal window: {e}"))?;
        // Let the hidden webview load the persisted cookies.
        tokio::time::sleep(Duration::from_millis(500)).await;
    }

    Ok(PortalStatus {
        signed_in: portal_signed_in(&app, &portal_url),
        portal_base_url: base,
    })
}
