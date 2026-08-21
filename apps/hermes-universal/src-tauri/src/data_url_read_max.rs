//! Size cap for local files the app reads into memory as a data URL (composer
//! attach: picker, drag-drop).
//!
//! Universal's client is a webview, and the webview cannot enforce this: by the
//! time JS holds a `Uint8Array` the allocation that kills the process has
//! already happened. On Android that failure is not a slow paint, it is the
//! system killing the process — no exception, no toast, no chip, the draft gone.
//! So the read moved down here, and the refusal happens BEFORE the buffer:
//! `metadata().len()` first, and a `take()`-bounded read second for the paths
//! that cannot answer up front (an Android SAF `content://` file descriptor
//! frequently stats as 0).
//!
//! The value itself is a device-local preference. Universal keeps those in the
//! webview (`store/data-url-read-max.ts`, on `persistentAtom`/localStorage like
//! keep-awake and translucency) because Rust has no sanctioned way to read a
//! WebKit/WKWebView localStorage database; the webview pushes it down here with
//! `set_data_url_read_max` on every change and once at startup. The two ends
//! therefore have to agree on the default and the bounds — the constants below
//! are the verbatim counterpart of `DATA_URL_READ_*` in
//! `apps/shared/src/data-url-read-max.ts`, pinned by tests on BOTH sides so
//! neither can drift alone.
//!
//! This is a memory guard, not a model limit. The 4096 ceiling is only a typo
//! guard — values well below it can still exhaust a phone.

use std::io::Read;
use std::sync::atomic::{AtomicU32, Ordering};

use base64::Engine as _;
use tauri::{AppHandle, Runtime, State};
use tauri_plugin_fs::{FilePath, FsExt, OpenOptions};

/// Ported from `apps/shared/src/data-url-read-max.ts`. Keep in lockstep with
/// `src/store/data-url-read-max.ts`; `pins_the_shared_literals` below and the
/// matching TS test are what make a one-sided edit fail.
pub const DATA_URL_READ_DEFAULT_MAX_MB: u32 = 16;
pub const DATA_URL_READ_MIN_MAX_MB: u32 = 1;
pub const DATA_URL_READ_MAX_MAX_MB: u32 = 4096;

const BYTES_PER_MB: u64 = 1024 * 1024;

/// The TS `clampDataUrlReadMaxMb`, byte for byte: a non-finite value falls back
/// to the default, everything else rounds and lands inside `MIN..=MAX`.
///
/// `f64::round` breaks .5 ties away from zero where `Math.round` breaks them
/// toward +∞. That only differs on negative halves (-2.5 → -3 here, -2 there),
/// and both sides of that disagreement clamp up to `MIN`, so the two functions
/// still agree on every result.
pub fn clamp_data_url_read_max_mb(value: f64) -> u32 {
    if !value.is_finite() {
        return DATA_URL_READ_DEFAULT_MAX_MB;
    }

    let rounded = value.round();

    if rounded < f64::from(DATA_URL_READ_MIN_MAX_MB) {
        DATA_URL_READ_MIN_MAX_MB
    } else if rounded > f64::from(DATA_URL_READ_MAX_MAX_MB) {
        DATA_URL_READ_MAX_MAX_MB
    } else {
        rounded as u32
    }
}

/// The cap in force, as the webview last pushed it.
pub struct DataUrlReadMaxState(AtomicU32);

impl Default for DataUrlReadMaxState {
    fn default() -> Self {
        Self(AtomicU32::new(DATA_URL_READ_DEFAULT_MAX_MB))
    }
}

impl DataUrlReadMaxState {
    pub fn max_mb(&self) -> u32 {
        self.0.load(Ordering::Relaxed)
    }

    pub fn max_bytes(&self) -> u64 {
        u64::from(self.max_mb()) * BYTES_PER_MB
    }

    fn store(&self, max_mb: u32) {
        self.0.store(max_mb, Ordering::Relaxed);
    }
}

/// A read that did not happen, told apart by cause.
///
/// `too_large` is the one the UI has to recognise: it is not a failure the user
/// can retry, it is a limit they can raise in Settings ▸ Chat, and the message
/// has to say so. Everything else (missing, unreadable, a `content://` the
/// resolver would not open) keeps the message it came with.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CappedReadError {
    pub too_large: bool,
    pub message: String,
}

impl CappedReadError {
    fn failed(message: impl Into<String>) -> Self {
        Self {
            too_large: false,
            message: message.into(),
        }
    }

    fn too_large(size: Option<u64>, max_bytes: u64) -> Self {
        let size = match size {
            Some(bytes) => format!("{bytes} bytes"),
            // The bounded read only ever learns "more than the cap".
            None => format!("more than {max_bytes} bytes"),
        };

        Self {
            too_large: true,
            message: format!("file is too large ({size}; limit {max_bytes} bytes)"),
        }
    }
}

/// Read at most `max_bytes` from `source`, refusing rather than truncating.
///
/// `known_len` is the stat the caller already has, when it has one: an oversized
/// file is turned away here without a single byte being buffered. When the stat
/// is absent or lies — an Android content-URI descriptor commonly reports 0 —
/// the `take` below is the real guard: it reads one byte PAST the cap, so an
/// overrun is detectable while the buffer stays bounded by the cap plus one.
fn read_capped(
    source: impl Read,
    known_len: Option<u64>,
    max_bytes: u64,
) -> Result<Vec<u8>, CappedReadError> {
    if let Some(len) = known_len {
        if len > max_bytes {
            return Err(CappedReadError::too_large(Some(len), max_bytes));
        }
    }

    let mut buffer = Vec::new();

    source
        .take(max_bytes + 1)
        .read_to_end(&mut buffer)
        .map_err(|error| CappedReadError::failed(error.to_string()))?;

    if buffer.len() as u64 > max_bytes {
        return Err(CappedReadError::too_large(None, max_bytes));
    }

    Ok(buffer)
}

/// Mirror the webview's preference down. Returns what actually took effect, so
/// a hand-edited localStorage cannot lift the cap past `MAX` — the clamp runs
/// on this side too and the caller writes the answer back into its atom.
#[tauri::command]
pub fn set_data_url_read_max(state: State<'_, DataUrlReadMaxState>, max_mb: f64) -> u32 {
    let next = clamp_data_url_read_max_mb(max_mb);
    state.store(next);

    next
}

/// Read a local file — or an Android `content://` URI — as base64, refusing
/// anything over the cap before it is allocated.
///
/// Base64 rather than bytes because the Tauri command boundary is JSON, where a
/// `Vec<u8>` serialises as an array of numbers: several times the size of
/// base64 and far more allocation on both sides (the same reasoning as
/// `transport.rs`'s `HttpUpload`). The caller prepends `data:<mime>;base64,` —
/// the MIME table already lives in `app/chat/attachments.ts` and there is no
/// reason for a second copy here.
///
/// Goes through `tauri_plugin_fs`'s `Fs::open` rather than `std::fs` on purpose:
/// that is the one API that resolves an Android SAF `content://` URI (through
/// the Kotlin side's `getFileDescriptor`) into a real `File`. `std::fs` cannot
/// open one at all, which would have made the mobile half — the whole point of
/// this guard — the half that stopped working.
#[tauri::command]
pub fn read_capped_file_base64<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, DataUrlReadMaxState>,
    path: String,
) -> Result<String, CappedReadError> {
    let max_bytes = state.max_bytes();

    let file_path: FilePath = path.parse().map_err(|error| {
        CappedReadError::failed(format!("{path} is not a readable path: {error}"))
    })?;

    let file = app
        .fs()
        .open(file_path, OpenOptions::new().read(true).clone())
        .map_err(|error| CappedReadError::failed(error.to_string()))?;

    // A descriptor that cannot be stat'd is not an error — it is exactly the
    // case the bounded read below exists for.
    let known_len = file.metadata().ok().map(|metadata| metadata.len());
    let bytes = read_capped(file, known_len, max_bytes)?;

    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::*;

    #[test]
    fn pins_the_shared_literals() {
        // These three numbers are a cross-language contract with
        // apps/shared/src/data-url-read-max.ts and src/store/data-url-read-max.ts.
        // Changing one without the others is the drift this asserts against.
        assert_eq!(DATA_URL_READ_DEFAULT_MAX_MB, 16);
        assert_eq!(DATA_URL_READ_MIN_MAX_MB, 1);
        assert_eq!(DATA_URL_READ_MAX_MAX_MB, 4096);
    }

    #[test]
    fn clamps_like_the_typescript_side() {
        // Non-finite is the DEFAULT, not the ceiling — `Number.isFinite`
        // rejects Infinity on the TS side too, so both fall back rather than
        // reading a typo as "4 GB is fine".
        assert_eq!(clamp_data_url_read_max_mb(f64::NAN), 16);
        assert_eq!(clamp_data_url_read_max_mb(f64::INFINITY), 16);
        assert_eq!(clamp_data_url_read_max_mb(0.0), 1);
        assert_eq!(clamp_data_url_read_max_mb(-9.0), 1);
        assert_eq!(clamp_data_url_read_max_mb(9000.0), 4096);
        assert_eq!(clamp_data_url_read_max_mb(31.6), 32);
        assert_eq!(clamp_data_url_read_max_mb(16.0), 16);
    }

    #[test]
    fn state_converts_megabytes_to_bytes() {
        let state = DataUrlReadMaxState::default();
        assert_eq!(state.max_bytes(), 16 * 1024 * 1024);

        state.store(2);
        assert_eq!(state.max_bytes(), 2 * 1024 * 1024);
    }

    #[test]
    fn refuses_before_reading_when_the_stat_is_already_over() {
        // A reader that would PANIC if touched: proves the stat check returns
        // before a single byte is pulled, which is the entire OOM guard.
        struct Explode;

        impl Read for Explode {
            fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
                panic!("read_capped must refuse an oversized file without reading it")
            }
        }

        let error = read_capped(Explode, Some(11), 10).expect_err("over the cap");
        assert!(error.too_large);
        assert!(error.message.contains("11 bytes"), "{}", error.message);
        assert!(
            error.message.contains("limit 10 bytes"),
            "{}",
            error.message
        );
    }

    #[test]
    fn refuses_an_unstattable_file_that_overruns_the_cap() {
        // The Android content-URI shape: the descriptor claims to know nothing,
        // so only the bounded read can catch it.
        let error = read_capped(Cursor::new(vec![7u8; 11]), None, 10).expect_err("over the cap");
        assert!(error.too_large);
        assert!(
            error.message.contains("more than 10 bytes"),
            "{}",
            error.message
        );
    }

    #[test]
    fn refuses_a_file_whose_stat_understates_it() {
        // A stat that LIES low (0 is what a SAF descriptor often reports) must
        // not become a way past the cap.
        let error = read_capped(Cursor::new(vec![7u8; 11]), Some(0), 10).expect_err("over the cap");
        assert!(error.too_large);
    }

    #[test]
    fn reads_a_file_exactly_on_the_cap() {
        // The boundary is inclusive: `> max`, not `>=`. A file of exactly the
        // configured size still attaches.
        let bytes = read_capped(Cursor::new(vec![7u8; 10]), Some(10), 10).expect("at the cap");
        assert_eq!(bytes.len(), 10);
    }

    #[test]
    fn reads_an_empty_file() {
        let bytes = read_capped(Cursor::new(Vec::new()), Some(0), 10).expect("an empty file");
        assert!(bytes.is_empty());
    }
}
