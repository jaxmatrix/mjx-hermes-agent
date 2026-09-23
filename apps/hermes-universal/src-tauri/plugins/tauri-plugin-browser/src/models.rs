use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

/// LOGICAL pixels in the Activity's / view controller's coordinate space. The
/// native halves convert to device pixels themselves, because only they know
/// the display density.
#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenRequest {
    pub guest_id: String,
    pub url: String,
    pub bounds: Bounds,
    /// The native → Rust push channel. This is how a mobile guest reports the
    /// things desktop cannot report at all: real load-error codes and real
    /// console lines.
    pub on_event: Channel<GuestEvent>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GuestRequest {
    pub guest_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NavigateRequest {
    pub guest_id: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoundsRequest {
    pub guest_id: String,
    pub bounds: Bounds,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VisibleRequest {
    pub guest_id: String,
    pub visible: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvalRequest {
    pub guest_id: String,
    pub script: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvalResponse {
    /// The JSON the engine produced, as a string — the same shape
    /// `Webview::eval_with_callback` hands back on desktop, so both halves feed
    /// one parser.
    pub value: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisibleResponse {
    /// The RESULTING visibility, not the requested one (rule 9).
    pub visible: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    /// `own` when the platform gave us a real second cookie jar,
    /// `ephemeral` when it gave us a non-persistent one, `shared` when the
    /// guest is stuck in the app's own jar (Android below WebView 114, which
    /// has no `ProfileStore`).
    pub isolated_store: String,
    /// Android/iOS answer `canGoBack` themselves, so the counted model is not
    /// used there.
    pub history_engine: bool,
    pub gestures: bool,
    pub console_push: bool,
    #[serde(default)]
    pub notes: Vec<String>,
}

/// What the native half pushes back. One flat enum so both platforms serialise
/// the same JSON.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum GuestEvent {
    #[serde(rename_all = "camelCase")]
    Load {
        guest_id: String,
        started: bool,
        url: String,
    },
    #[serde(rename_all = "camelCase")]
    Nav {
        guest_id: String,
        url: String,
        #[serde(default)]
        title: String,
        can_back: bool,
        can_forward: bool,
    },
    #[serde(rename_all = "camelCase")]
    Error {
        guest_id: String,
        #[serde(default)]
        code: Option<i32>,
        description: String,
        url: String,
    },
    #[serde(rename_all = "camelCase")]
    Console {
        guest_id: String,
        entries: serde_json::Value,
    },
    /// A URL the guard refused — a `mailto:`, a `target=_blank`, a download.
    /// The host decides what to do with it; the native half never opens it.
    #[serde(rename_all = "camelCase")]
    External { guest_id: String, url: String },
}
