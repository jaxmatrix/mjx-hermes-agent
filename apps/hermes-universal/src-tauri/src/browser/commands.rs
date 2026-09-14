//! The Tauri command surface for the in-app browser.
//!
//! All `snake_case` names, all args camelCase on the wire, all
//! `Result<T, BrowserError>` so the frontend can branch on a KIND rather than
//! matching on prose. None needs a `capabilities/default.json` entry — these
//! are app commands, not plugin/core commands, and app commands are ACL-checked
//! only for a remote origin. The guest never gets to call them: it is denied by
//! the navigation guard, by its label being outside every `webviews` glob, and
//! by being a remote origin. See `policy.rs`.

use std::time::Duration;

use tauri::{AppHandle, State, Window};

use super::{
    reach, BrowserCapabilities, BrowserError, BrowserState, GuestBounds, GuestState,
    BROWSER_GUEST_ID,
};
use crate::ssh::SshState;

/// The default eval budget. Long enough for a slow page's `innerText`, short
/// enough to answer inside the gateway's 45 s bridge.
const DEFAULT_EVAL_TIMEOUT_MS: u64 = 5_000;
const MAX_EVAL_TIMEOUT_MS: u64 = 30_000;

#[tauri::command]
pub async fn browser_capabilities(app: AppHandle) -> Result<BrowserCapabilities, BrowserError> {
    Ok(super::capabilities(&app))
}

#[tauri::command]
pub async fn browser_open(
    app: AppHandle,
    window: Window,
    state: State<'_, BrowserState>,
    guest_id: Option<String>,
    url: String,
    bounds: GuestBounds,
) -> Result<GuestState, BrowserError> {
    let id = guest_id.unwrap_or_else(|| BROWSER_GUEST_ID.to_string());

    state.open(&app, window.label(), id, &url, bounds).await
}

#[tauri::command]
pub async fn browser_navigate(
    state: State<'_, BrowserState>,
    guest_id: String,
    url: String,
) -> Result<GuestState, BrowserError> {
    state.navigate(&guest_id, &url).await
}

#[tauri::command]
pub async fn browser_back(
    state: State<'_, BrowserState>,
    guest_id: String,
) -> Result<GuestState, BrowserError> {
    state.go(&guest_id, false).await
}

#[tauri::command]
pub async fn browser_forward(
    state: State<'_, BrowserState>,
    guest_id: String,
) -> Result<GuestState, BrowserError> {
    state.go(&guest_id, true).await
}

#[tauri::command]
pub async fn browser_reload(
    state: State<'_, BrowserState>,
    guest_id: String,
) -> Result<GuestState, BrowserError> {
    state.reload(&guest_id).await
}

#[tauri::command]
pub async fn browser_stop(
    state: State<'_, BrowserState>,
    guest_id: String,
) -> Result<GuestState, BrowserError> {
    state.stop(&guest_id).await
}

#[tauri::command]
pub async fn browser_set_bounds(
    state: State<'_, BrowserState>,
    guest_id: String,
    bounds: GuestBounds,
) -> Result<(), BrowserError> {
    state.set_bounds(&guest_id, bounds).await
}

/// Returns the RESULTING visibility, not `()` — rule 9. The occlusion arbiter
/// reads it back rather than assuming the call took.
#[tauri::command]
pub async fn browser_set_visible(
    state: State<'_, BrowserState>,
    guest_id: String,
    visible: bool,
) -> Result<bool, BrowserError> {
    state.set_visible(&guest_id, visible).await
}

/// The ONE eval door: the page reader, the act engine, the console drain and
/// the tour surface all ride it.
///
/// Splitting it into three narrow commands would move the same power behind
/// three names and put the reader/act logic in Rust, where it cannot be
/// unit-tested without a display server. It is not a new grant either: a loaded
/// plugin already evaluates as ESM in the app webview with the app's full
/// authority.
#[tauri::command]
pub async fn browser_eval(
    state: State<'_, BrowserState>,
    guest_id: String,
    script: String,
    timeout_ms: Option<u64>,
) -> Result<String, BrowserError> {
    let ms = timeout_ms
        .unwrap_or(DEFAULT_EVAL_TIMEOUT_MS)
        .clamp(1, MAX_EVAL_TIMEOUT_MS);

    state
        .eval(&guest_id, &script, Duration::from_millis(ms))
        .await
}

#[tauri::command]
pub async fn browser_clear_data(
    state: State<'_, BrowserState>,
    guest_id: String,
) -> Result<(), BrowserError> {
    state.clear_data(&guest_id).await
}

/// Whether it actually opened. There is no `is_devtools_open` on a child
/// webview, so the glyph reflects OUR last command — a two-state button, not a
/// mirror, and the return value is what makes that honest.
#[tauri::command]
pub async fn browser_open_devtools(
    state: State<'_, BrowserState>,
    guest_id: String,
) -> Result<bool, BrowserError> {
    state.open_devtools(&guest_id).await
}

#[tauri::command]
pub async fn browser_close(
    app: AppHandle,
    state: State<'_, BrowserState>,
    guest_id: String,
) -> Result<(), BrowserError> {
    state.close(&app, &guest_id).await
}

/// Resolve a URL against the SSH forward lease.
///
/// NEVER errors for "unreachable": it reports through `note` and hands back the
/// original URL, because a `url`/`cloud`/`local` gateway having no tunnel to
/// borrow is not a failure.
#[tauri::command]
pub async fn browser_reach_url(
    state: State<'_, BrowserState>,
    ssh: State<'_, SshState>,
    url: String,
    scope_key: String,
) -> Result<reach::ReachResult, BrowserError> {
    Ok(reach::reach(&state.leases, &ssh, &url, &scope_key).await)
}

/// Drop leases. `None` means every scope — the gateway-switch door.
#[tauri::command]
pub async fn browser_reach_reset(
    state: State<'_, BrowserState>,
    scope_key: Option<String>,
) -> Result<u32, BrowserError> {
    Ok(match scope_key {
        Some(scope) => state.leases.drop_scope(&scope).await,
        None => state.leases.drop_all().await,
    })
}
