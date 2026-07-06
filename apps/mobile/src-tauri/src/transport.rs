//! Generic network transport that runs entirely in Rust (Step 2a).
//!
//! The webview never opens a socket or issues `fetch` itself — it drives this
//! module over IPC. That removes the browser CORS constraint entirely (a native
//! client has no origin policy), so the app can talk to any Hermes/service on
//! the LAN or elsewhere.
//!
//! This is a *thin, generic* pipe on purpose: `http_request` proxies any REST
//! call, and `ws_open`/`ws_send`/`ws_close` proxy a raw WebSocket, forwarding
//! every server frame to the webview as a Tauri event. The JSON-RPC framing and
//! request/response correlation stay in the reused JS `JsonRpcGatewayClient`,
//! which drives this via an IPC-backed `WebSocketLike`.

use std::collections::HashMap;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

/// A live raw WebSocket: `tx` feeds the writer task; the two task handles are
/// aborted on close.
pub struct SocketHandle {
    tx: mpsc::UnboundedSender<Message>,
    reader: tokio::task::JoinHandle<()>,
    writer: tokio::task::JoinHandle<()>,
}

pub struct TransportState {
    http: reqwest::Client,
    sockets: Mutex<HashMap<String, SocketHandle>>,
}

impl TransportState {
    pub fn new() -> Self {
        let http = reqwest::Client::builder()
            .user_agent(concat!("hermes-mobile/", env!("CARGO_PKG_VERSION")))
            // Retain the login session cookie across http_request calls so the
            // subsequent POST /api/auth/ws-ticket is authenticated (gated mode).
            .cookie_store(true)
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self {
            http,
            sockets: Mutex::new(HashMap::new()),
        }
    }
}

impl Default for TransportState {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpReq {
    method: String,
    url: String,
    #[serde(default)]
    headers: HashMap<String, String>,
    #[serde(default)]
    body: Option<serde_json::Value>,
    #[serde(default)]
    timeout_ms: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpResp {
    status: u16,
    headers: HashMap<String, String>,
    body: String,
}

/// Generic REST proxy. Powers `/api/status` probing, session create/history,
/// and the OAuth ws-ticket mint — all with the auth header/cookie attached here
/// in Rust rather than in the webview.
#[tauri::command]
pub async fn http_request(
    state: State<'_, TransportState>,
    req: HttpReq,
) -> Result<HttpResp, String> {
    let method = reqwest::Method::from_bytes(req.method.to_uppercase().as_bytes())
        .map_err(|e| format!("invalid method {}: {e}", req.method))?;
    let mut builder = state.http.request(method, &req.url);
    for (key, value) in &req.headers {
        builder = builder.header(key, value);
    }
    if let Some(body) = &req.body {
        builder = builder.json(body);
    }
    if let Some(ms) = req.timeout_ms {
        builder = builder.timeout(Duration::from_millis(ms));
    }

    let resp = builder.send().await.map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();
    let headers = resp
        .headers()
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or_default().to_string()))
        .collect();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    Ok(HttpResp {
        status,
        headers,
        body,
    })
}

/// Open a raw WebSocket. The *client* supplies `id` (a uuid) and subscribes to
/// `ws://{id}/open|message|close|error` BEFORE calling this, so no frame is
/// missed. `origin` is set on the upgrade because auth-gated gateways guard the
/// handshake on Host/Origin (see desktop `gateway-ws-probe.cjs`).
#[tauri::command]
pub async fn ws_open(
    app: AppHandle,
    state: State<'_, TransportState>,
    id: String,
    url: String,
    origin: Option<String>,
) -> Result<(), String> {
    let mut request = url
        .clone()
        .into_client_request()
        .map_err(|e| format!("invalid ws url {url}: {e}"))?;
    if let Some(origin) = origin {
        if let Ok(value) = origin.parse() {
            request.headers_mut().insert("Origin", value);
        }
    }

    let (stream, _resp) = tokio_tungstenite::connect_async(request)
        .await
        .map_err(|e| e.to_string())?;
    let (mut write, mut read) = stream.split();

    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();

    let writer = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if write.send(msg).await.is_err() {
                break;
            }
        }
    });

    let app_reader = app.clone();
    let tx_pong = tx.clone();
    let id_reader = id.clone();
    let reader = tokio::spawn(async move {
        while let Some(item) = read.next().await {
            match item {
                Ok(Message::Text(text)) => {
                    let _ = app_reader.emit(&format!("ws://{id_reader}/message"), text.to_string());
                }
                Ok(Message::Ping(payload)) => {
                    // Split streams don't auto-respond to pings; keepalive by hand.
                    let _ = tx_pong.send(Message::Pong(payload));
                }
                Ok(Message::Close(_)) => break,
                Ok(_) => {}
                Err(err) => {
                    let _ = app_reader.emit(&format!("ws://{id_reader}/error"), err.to_string());
                    break;
                }
            }
        }
        let _ = app_reader.emit(&format!("ws://{id_reader}/close"), ());
    });

    state
        .sockets
        .lock()
        .await
        .insert(id.clone(), SocketHandle { tx, reader, writer });

    let _ = app.emit(&format!("ws://{id}/open"), ());
    Ok(())
}

#[tauri::command]
pub async fn ws_send(
    state: State<'_, TransportState>,
    id: String,
    text: String,
) -> Result<(), String> {
    let sockets = state.sockets.lock().await;
    let handle = sockets.get(&id).ok_or("socket not found")?;
    handle
        .tx
        .send(Message::Text(text.into()))
        .map_err(|_| "socket closed".to_string())
}

#[tauri::command]
pub async fn ws_close(state: State<'_, TransportState>, id: String) -> Result<(), String> {
    if let Some(handle) = state.sockets.lock().await.remove(&id) {
        handle.reader.abort();
        handle.writer.abort();
    }
    Ok(())
}
