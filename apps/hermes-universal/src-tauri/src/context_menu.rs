//! The app-wide context menu's native half (MJXHRM-478).
//!
//! Two jobs, and they are less related than the shared module name suggests.
//!
//! **1. The bridge (v1: all-stub, deliberately).** Desktop's Electron build
//! never called `preventDefault()` on `contextmenu` — Chromium's main-process
//! `context-menu` event was its spellcheck and image-coordinate source, and with
//! no `Menu.popup` anywhere "default" already meant "no menu". Every engine
//! universal ships on inverts that: WebKitGTK, WKWebView, WebView2 and the
//! Android WebView each pop their OWN menu for an unprevented gesture, so the
//! webview must cancel it — and loses the channel those late facts arrived on.
//!
//! `context_menu_install` is where they come back, from the EMBEDDER instead of
//! from the page. In v1 it answers `BridgeSupport::default()` — nothing
//! suppressed, nothing promised — on every platform, and that is a true answer
//! rather than a stub that lies (rule 10): the JS menu reads it, reports it in
//! its diagnostics, and behaves exactly as if no bridge existed.
//!
//! A v2 engine adapter (`connect_context_menu` on WebKitGTK,
//! `ContextMenuRequested` on WebView2, `willOpenMenu:` on WKWebView,
//! `getHitTestResult` on Android) replaces `imp::install`'s body — following the
//! `find_in_page.rs` shape, including its `wired` set, because `with_webview`
//! runs per call and would otherwise stack a handler per invocation. It adds no
//! command, no event, no capability entry and no JavaScript edit, which is the
//! entire reason this module ships before it has an adapter.
//!
//! **2. The image verbs, which are real today.** `capabilities/default.json`
//! grants `fs:allow-write-text-file` and no binary write, and
//! `clipboard-manager:allow-read-image` and no image write. Widening either
//! would widen the ACL for EVERY window label in that glob list, while our own
//! `#[tauri::command]`s need no entry at all — so the Rust command is both the
//! smaller diff and the narrower grant.
//!
//! The bytes arrive as a `data:` URL. Under this app's CSP (`img-src 'self'
//! data:`) an image that RENDERED is already one, and a gateway path that was
//! not yet resolved is resolved *in the webview* — Rust has no gateway base URL
//! of its own and must not grow one (rule 3). So `ImageSource` carries decoded
//! bytes' transport, not a fetch instruction, and a page cannot make Rust reach
//! an arbitrary host.

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;

/// Emitted to ONE window (`emit_to`, never `app.emit`) with the facts only the
/// engine can see. v2 seam: nothing emits it in v1.
#[allow(dead_code)]
pub const CONTEXT_MENU_NATIVE_EVENT: &str = "hermes://context-menu";

/// A data URL bigger than this is refused before it is decoded. The bytes are
/// already resident in the webview; doubling that without a bound is how a
/// pasted 200 MB PNG takes the process down.
const MAX_IMAGE_BYTES: usize = 32 * 1024 * 1024;

/// What the platform bridge can actually do in this window.
///
/// Returned by `context_menu_install` rather than inferred from a call that did
/// not throw (rule 10). All-false is the honest v1 answer everywhere.
#[derive(Clone, Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeSupport {
    /// The native menu is suppressed by the embedder, not only by the DOM event.
    pub native_suppressed: bool,
    /// Spelling guesses will be delivered on `hermes://context-menu`.
    pub spelling: bool,
    /// The engine can hand over image bytes the DOM cannot reach.
    pub image_bytes: bool,
}

/// Late facts pushed to the webview. Mirrors `NativeContextFacts` in
/// `src/app/context-menu/registry.ts`. v2 seam — nothing constructs it in v1.
#[allow(dead_code)]
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeContextFacts {
    pub gesture_id: u64,
    pub spelling: Option<SpellingFacts>,
    pub image_bytes: bool,
}

#[allow(dead_code)]
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpellingFacts {
    pub misspelled_word: String,
    pub suggestions: Vec<String>,
}

/// Where the image bytes come from.
///
/// One variant on purpose: the webview resolves every source to a `data:` URL
/// before it invokes, because it is the half that knows the gateway. Tagged so a
/// second variant (an engine hit-test handing over bytes the DOM never had) is
/// additive rather than a signature change.
#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind", content = "value")]
pub enum ImageSource {
    Data(String),
}

/// Structured because the frontend genuinely branches: an unsupported platform
/// hides the row, a bad image is a bug in what we sent, and a platform refusal
/// carries a message worth showing (recipe 6.1 step 10).
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ContextMenuError {
    /// Not decodable, empty, or past the byte cap.
    BadImage,
    /// Clipboard / filesystem refused; carries the OS message.
    Platform(String),
    /// This platform has no path for this action at all. Constructed only on
    /// mobile, where the clipboard plugin implements no image write.
    #[cfg_attr(desktop, allow(dead_code))]
    UnsupportedPlatform,
}

#[derive(Default)]
pub struct ContextMenuState {
    /// Windows whose bridge is already installed. `with_webview` runs per call,
    /// so without this a second install would stack a second handler set — the
    /// exact bug `find_in_page.rs` carries the same set to avoid.
    wired: std::sync::Mutex<std::collections::HashSet<String>>,
}

/// The per-engine adapter seam.
///
/// One module rather than five identical files: every target answers the same
/// all-false descriptor in v1, and five copies of that would be duplicated dead
/// code, not a seam. A real adapter arrives as `#[cfg_attr(target_os = "linux",
/// path = "context_menu/linux.rs")] mod imp;` over this module's signature —
/// which is the only thing v2 needs to keep stable.
mod imp {
    use super::BridgeSupport;

    pub fn install<R: tauri::Runtime>(_window: &tauri::WebviewWindow<R>) -> BridgeSupport {
        BridgeSupport::default()
    }

    /// Returns whether the native menu is ACTUALLY suppressed by the embedder
    /// afterwards — not whether the call succeeded (rule 9). v1 has no lever, so
    /// the honest answer is false and the JS never branches on it.
    pub fn set_suppressed<R: tauri::Runtime>(
        _window: &tauri::WebviewWindow<R>,
        _suppressed: bool,
    ) -> bool {
        false
    }
}

/// Decode a `data:` URL's payload, bounded.
pub fn decode_data_url(url: &str) -> Result<Vec<u8>, ContextMenuError> {
    let rest = url
        .strip_prefix("data:")
        .ok_or(ContextMenuError::BadImage)?;
    let comma = rest.find(',').ok_or(ContextMenuError::BadImage)?;

    if !rest[..comma]
        .split(';')
        .any(|part| part.eq_ignore_ascii_case("base64"))
    {
        return Err(ContextMenuError::BadImage);
    }

    let payload = &rest[comma + 1..];

    // Refuse BEFORE allocating: base64 is 4 chars per 3 bytes, so the encoded
    // length already bounds the decoded one.
    if payload.len() / 4 * 3 > MAX_IMAGE_BYTES {
        return Err(ContextMenuError::BadImage);
    }

    let bytes = BASE64
        .decode(payload)
        .map_err(|_| ContextMenuError::BadImage)?;

    if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
        return Err(ContextMenuError::BadImage);
    }

    Ok(bytes)
}

fn image_bytes(source: &ImageSource) -> Result<Vec<u8>, ContextMenuError> {
    match source {
        ImageSource::Data(url) => decode_data_url(url),
    }
}

/// Arm this window's bridge and report what it can do. Idempotent.
#[tauri::command]
pub async fn context_menu_install(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, ContextMenuState>,
) -> Result<BridgeSupport, String> {
    let first_time = state
        .wired
        .lock()
        .map(|mut set| set.insert(window.label().to_string()))
        .unwrap_or(false);

    if !first_time {
        // A second call is a no-op that still answers the descriptor — the
        // caller asked what this window can do, not to wire it again.
        return Ok(imp::install(&window));
    }

    Ok(imp::install(&window))
}

/// Ask the embedder to suppress (or restore) its own menu, and report the state
/// that actually resulted.
#[tauri::command]
pub async fn context_menu_set_suppressed(
    window: tauri::WebviewWindow,
    suppressed: bool,
) -> Result<bool, String> {
    Ok(imp::set_suppressed(&window, suppressed))
}

/// Put the image on the system clipboard.
#[tauri::command]
pub async fn context_menu_copy_image(
    #[allow(unused_variables)] app: tauri::AppHandle,
    source: ImageSource,
) -> Result<(), ContextMenuError> {
    let bytes = image_bytes(&source)?;

    #[cfg(desktop)]
    {
        use tauri_plugin_clipboard_manager::ClipboardExt;

        // PNG only — `Image::from_bytes` decodes nothing else, and the webview
        // has already re-encoded anything that was not one (it holds a decoded
        // element; Rust would need an image codec crate to do the same work).
        let image = tauri::image::Image::from_bytes(&bytes)
            .map_err(|e| ContextMenuError::Platform(e.to_string()))?;

        app.clipboard()
            .write_image(&image)
            .map_err(|e| ContextMenuError::Platform(e.to_string()))
    }

    // The clipboard plugin's `write_image` is unimplemented on Android and iOS,
    // so the frontend hides the row entirely — a control that can never succeed
    // should not be offered. This is the answer for a call that got here anyway.
    #[cfg(mobile)]
    {
        let _ = bytes;

        Err(ContextMenuError::UnsupportedPlatform)
    }
}

/// Write the image to a path the user chose in the OS picker.
///
/// Rust does not join, normalise or invent the path: it came from `save()`, so
/// the user chose it, and inventing one is how a "save" writes somewhere else.
/// Returns the path written (rule 9 — say what happened, not "no error").
#[tauri::command]
pub async fn context_menu_save_image(
    source: ImageSource,
    path: String,
) -> Result<String, ContextMenuError> {
    let bytes = image_bytes(&source)?;

    std::fs::write(&path, &bytes).map_err(|e| ContextMenuError::Platform(e.to_string()))?;

    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 1×1 transparent PNG.
    const PNG: &str = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

    #[test]
    fn decodes_a_well_formed_data_url() {
        let bytes = decode_data_url(PNG).expect("decodes");

        assert_eq!(&bytes[..4], b"\x89PNG");
    }

    #[test]
    fn rejects_a_malformed_data_url() {
        for bad in [
            "https://example.test/a.png",
            "data:image/png,notbase64",
            "data:image/png;base64",
            "data:image/png;base64,****",
            "data:image/png;base64,",
        ] {
            assert!(
                matches!(decode_data_url(bad), Err(ContextMenuError::BadImage)),
                "expected BadImage for {bad}"
            );
        }
    }

    #[test]
    fn refuses_past_the_byte_cap() {
        // Encoded length alone is over the cap, so this is refused without ever
        // allocating the decoded buffer.
        let oversized = format!(
            "data:image/png;base64,{}",
            "A".repeat(MAX_IMAGE_BYTES / 3 * 4 + 8)
        );

        assert!(matches!(
            decode_data_url(&oversized),
            Err(ContextMenuError::BadImage)
        ));
    }

    #[test]
    fn bridge_support_defaults_to_all_false() {
        // Pins "an all-false descriptor is a true answer": if a later edit makes
        // any of these default to true, the JS would claim a capability that has
        // no adapter behind it.
        let json = serde_json::to_value(BridgeSupport::default()).expect("serialises");

        assert_eq!(json["nativeSuppressed"], serde_json::json!(false));
        assert_eq!(json["spelling"], serde_json::json!(false));
        assert_eq!(json["imageBytes"], serde_json::json!(false));
    }

    #[test]
    fn errors_serialise_kebab_case() {
        // The frontend reads these as literals to decide between hiding a row
        // and showing a toast.
        assert_eq!(
            serde_json::to_value(ContextMenuError::UnsupportedPlatform).expect("serialises"),
            serde_json::json!("unsupported-platform")
        );
        assert_eq!(
            serde_json::to_value(ContextMenuError::BadImage).expect("serialises"),
            serde_json::json!("bad-image")
        );
        assert_eq!(
            serde_json::to_value(ContextMenuError::Platform("nope".into())).expect("serialises"),
            serde_json::json!({ "platform": "nope" })
        );
    }

    #[test]
    fn image_source_deserialises_the_tagged_shape() {
        let source: ImageSource =
            serde_json::from_value(serde_json::json!({ "kind": "data", "value": PNG }))
                .expect("deserialises");

        assert!(matches!(source, ImageSource::Data(url) if url == PNG));
    }
}
