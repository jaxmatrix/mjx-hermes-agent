//! Client-side loopback callback for MCP OAuth against a remote backend
//! (Electron `mcp-oauth-callback-ipc.ts`).
//!
//! The gateway’s own `mcp.servers.oauth.start` binds on the BACKEND machine’s
//! 127.0.0.1 — unreachable from the user’s browser over SSH/Tailscale. This
//! module binds an ephemeral one-shot listener on the USER’S loopback, hands
//! its URL to the gateway as `client_redirect_uri`, and resolves with the
//! redirect’s `code`/`state`/`iss` so the renderer can relay them via
//! `mcp.servers.oauth.callback`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tauri::State;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use tokio::sync::{oneshot, Mutex};

const DEFAULT_WAIT_TIMEOUT_MS: u64 = 5 * 60 * 1000;
const MAX_WAIT_TIMEOUT_MS: u64 = 15 * 60 * 1000;
const MIN_WAIT_TIMEOUT_MS: u64 = 1000;
const MAX_PENDING_LISTENERS: usize = 8;
const SOCKET_READ_SECS: u64 = 5;

const DONE_HTML: &str = concat!(
    "<!doctype html><meta charset=\"utf-8\"><title>Authorization received</title>",
    "<body style=\"font:15px system-ui;margin:3rem;text-align:center\">",
    "<h2>&#10003; Authorization received</h2>",
    "<p>You can close this window and return to Hermes.</p>",
    "<script>setTimeout(()=>window.close(),800)</script>"
);

#[derive(Clone, Debug, Serialize)]
pub struct CallbackResult {
    pub code: Option<String>,
    pub error: Option<String>,
    pub iss: Option<String>,
    pub state: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListenResult {
    pub id: String,
    pub redirect_uri: String,
}

struct Pending {
    result: Option<CallbackResult>,
    waiters: Vec<oneshot::Sender<CallbackResult>>,
    abort: tokio::task::AbortHandle,
}

struct Inner {
    pending: Mutex<HashMap<String, Pending>>,
    next_id: AtomicU64,
}

pub struct McpOauthState {
    inner: Arc<Inner>,
}

impl Default for McpOauthState {
    fn default() -> Self {
        Self {
            inner: Arc::new(Inner {
                pending: Mutex::new(HashMap::new()),
                next_id: AtomicU64::new(0),
            }),
        }
    }
}

fn parse_callback(target: &str) -> CallbackResult {
    let Ok(url) = url::Url::parse(&format!("http://127.0.0.1{target}")) else {
        return CallbackResult {
            code: None,
            error: Some("unparseable callback URL".into()),
            iss: None,
            state: None,
        };
    };
    CallbackResult {
        code: url
            .query_pairs()
            .find(|(k, _)| k == "code")
            .map(|(_, v)| v.into_owned()),
        error: url
            .query_pairs()
            .find(|(k, _)| k == "error")
            .map(|(_, v)| v.into_owned()),
        iss: url
            .query_pairs()
            .find(|(k, _)| k == "iss")
            .map(|(_, v)| v.into_owned()),
        state: url
            .query_pairs()
            .find(|(k, _)| k == "state")
            .map(|(_, v)| v.into_owned()),
    }
}

fn is_oauth_hit(target: &str) -> bool {
    // Match Electron: /[?&](code|error)=/
    let bytes = target.as_bytes();
    for (i, &b) in bytes.iter().enumerate() {
        if (b == b'?' || b == b'&') && i + 1 < bytes.len() {
            let rest = &target[i + 1..];
            if rest.starts_with("code=") || rest.starts_with("error=") {
                return true;
            }
        }
    }
    false
}

async fn serve_one(stream: tokio::net::TcpStream) -> Option<CallbackResult> {
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    let read = tokio::time::timeout(
        Duration::from_secs(SOCKET_READ_SECS),
        reader.read_line(&mut line),
    )
    .await;
    if !matches!(read, Ok(Ok(_))) {
        return None;
    }
    let target = line.split_whitespace().nth(1).unwrap_or("").to_string();

    let body = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        DONE_HTML.len(),
        DONE_HTML
    );
    let mut stream = reader.into_inner();
    let _ = stream.write_all(body.as_bytes()).await;
    let _ = stream.flush().await;
    let _ = stream.shutdown().await;

    if !is_oauth_hit(&target) {
        return None;
    }
    Some(parse_callback(&target))
}

async fn settle(inner: &Inner, id: &str, result: CallbackResult) {
    let mut map = inner.pending.lock().await;
    let Some(entry) = map.get_mut(id) else {
        return;
    };
    if entry.result.is_some() {
        return;
    }
    entry.result = Some(result.clone());
    entry.abort.abort();
    for waiter in entry.waiters.drain(..) {
        let _ = waiter.send(result.clone());
    }
}

#[tauri::command]
pub async fn mcp_oauth_listen(state: State<'_, McpOauthState>) -> Result<ListenResult, String> {
    let inner = Arc::clone(&state.inner);

    {
        let map = inner.pending.lock().await;
        if map.len() >= MAX_PENDING_LISTENERS {
            return Err("Too many MCP OAuth listeners are already pending".into());
        }
    }

    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("could not bind MCP OAuth loopback: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("could not read MCP OAuth loopback port: {e}"))?
        .port();

    let id = (inner.next_id.fetch_add(1, Ordering::Relaxed) + 1).to_string();
    let accept_id = id.clone();
    let accept_inner = Arc::clone(&inner);

    let join = tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                break;
            };
            if let Some(result) = serve_one(stream).await {
                settle(&accept_inner, &accept_id, result).await;
                break;
            }
        }
    });

    inner.pending.lock().await.insert(
        id.clone(),
        Pending {
            result: None,
            waiters: Vec::new(),
            abort: join.abort_handle(),
        },
    );

    Ok(ListenResult {
        id,
        redirect_uri: format!("http://127.0.0.1:{port}/callback"),
    })
}

#[tauri::command]
pub async fn mcp_oauth_wait(
    state: State<'_, McpOauthState>,
    id: String,
    timeout_ms: Option<u64>,
) -> Result<CallbackResult, String> {
    let inner = Arc::clone(&state.inner);
    let id = id.trim().to_string();

    {
        let mut map = inner.pending.lock().await;
        let Some(entry) = map.get_mut(&id) else {
            return Ok(CallbackResult {
                code: None,
                error: Some("listener not found".into()),
                iss: None,
                state: None,
            });
        };
        if let Some(result) = entry.result.clone() {
            map.remove(&id);
            return Ok(result);
        }
    }

    let timeout = timeout_ms
        .unwrap_or(DEFAULT_WAIT_TIMEOUT_MS)
        .clamp(MIN_WAIT_TIMEOUT_MS, MAX_WAIT_TIMEOUT_MS);

    let (tx, rx) = oneshot::channel();
    {
        let mut map = inner.pending.lock().await;
        let Some(entry) = map.get_mut(&id) else {
            return Ok(CallbackResult {
                code: None,
                error: Some("listener not found".into()),
                iss: None,
                state: None,
            });
        };
        if let Some(result) = entry.result.clone() {
            map.remove(&id);
            return Ok(result);
        }
        entry.waiters.push(tx);
    }

    let result = tokio::select! {
        got = rx => got.unwrap_or(CallbackResult {
            code: None,
            error: Some("cancelled".into()),
            iss: None,
            state: None,
        }),
        _ = tokio::time::sleep(Duration::from_millis(timeout)) => {
            settle(
                &inner,
                &id,
                CallbackResult {
                    code: None,
                    error: Some("timeout waiting for OAuth callback".into()),
                    iss: None,
                    state: None,
                },
            )
            .await;
            // Waiter may already have been sent by settle; fall through to map.
            CallbackResult {
                code: None,
                error: Some("timeout waiting for OAuth callback".into()),
                iss: None,
                state: None,
            }
        }
    };

    // Prefer the settled result from the map when present (timeout path may
    // race with a late callback that settle already delivered to waiters).
    let final_result = {
        let mut map = inner.pending.lock().await;
        let out = map.remove(&id).and_then(|e| e.result).unwrap_or(result);
        out
    };

    Ok(final_result)
}

#[tauri::command]
pub async fn mcp_oauth_cancel(state: State<'_, McpOauthState>, id: String) -> Result<bool, String> {
    let inner = Arc::clone(&state.inner);
    let id = id.trim().to_string();

    {
        let map = inner.pending.lock().await;
        if !map.contains_key(&id) {
            return Ok(true);
        }
    }

    settle(
        &inner,
        &id,
        CallbackResult {
            code: None,
            error: Some("cancelled".into()),
            iss: None,
            state: None,
        },
    )
    .await;

    inner.pending.lock().await.remove(&id);
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oauth_hit_detects_code_and_error() {
        assert!(is_oauth_hit("/callback?code=abc&state=s"));
        assert!(is_oauth_hit("/callback?error=access_denied"));
        assert!(!is_oauth_hit("/favicon.ico"));
        assert!(!is_oauth_hit("/callback"));
    }

    #[test]
    fn parse_pulls_iss() {
        let r = parse_callback("/callback?code=c&state=s&iss=https%3A%2F%2Fissuer.example");
        assert_eq!(r.code.as_deref(), Some("c"));
        assert_eq!(r.state.as_deref(), Some("s"));
        assert_eq!(r.iss.as_deref(), Some("https://issuer.example"));
    }
}
