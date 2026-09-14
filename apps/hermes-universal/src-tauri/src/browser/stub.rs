//! The adapter for a target with no guest host: a desktop build compiled
//! WITHOUT `tauri/unstable`, or any future platform we have not written one for.
//!
//! It refuses loudly and by name (rule 9). Silently no-op'ing would leave the
//! pane showing an empty rectangle with no way for the user — or the agent — to
//! find out why, and `open_preview` would look like it worked.

use std::sync::Arc;

use tauri::{AppHandle, Url};
use tokio::sync::oneshot;

use super::{
    ActInjection, BrowserCapabilities, BrowserError, ConsoleSource, GuestBounds, GuestHost,
    GuestId, HistorySource, HostKind, LoadErrorSource, StoreKind,
};

#[allow(dead_code)]
pub struct NoHost;

impl GuestHost for NoHost {
    fn navigate(&self, _url: &Url) -> Result<(), BrowserError> {
        Err(BrowserError::unsupported())
    }
    fn back(&self) -> Result<(), BrowserError> {
        Err(BrowserError::unsupported())
    }
    fn forward(&self) -> Result<(), BrowserError> {
        Err(BrowserError::unsupported())
    }
    fn reload(&self) -> Result<(), BrowserError> {
        Err(BrowserError::unsupported())
    }
    fn stop(&self) -> Result<(), BrowserError> {
        Err(BrowserError::unsupported())
    }
    fn set_bounds(&self, _bounds: GuestBounds) -> Result<(), BrowserError> {
        Err(BrowserError::unsupported())
    }
    fn set_visible(&self, _visible: bool) -> Result<bool, BrowserError> {
        Err(BrowserError::unsupported())
    }
    fn eval(&self, _js: &str) -> Result<oneshot::Receiver<String>, BrowserError> {
        Err(BrowserError::unsupported())
    }
    fn clear_data(&self) -> Result<(), BrowserError> {
        Err(BrowserError::unsupported())
    }
    fn open_devtools(&self) -> Result<bool, BrowserError> {
        Err(BrowserError::unsupported())
    }
    fn close(&self) -> Result<(), BrowserError> {
        Ok(())
    }
}

#[allow(dead_code)]
pub fn capabilities(_app: &AppHandle) -> BrowserCapabilities {
    BrowserCapabilities {
        platform: super::platform_name(),
        host: HostKind::None,
        isolated_store: StoreKind::Ephemeral,
        history: HistorySource::Estimated,
        gestures: false,
        console: ConsoleSource::None,
        devtools: false,
        load_errors: LoadErrorSource::Timeout,
        act: ActInjection::Dom,
        notes: vec![
            "This build has no in-app browser host: desktop needs the `unstable` cargo feature for child webviews.".to_string(),
        ],
    }
}

#[allow(dead_code)]
pub fn build(
    _app: &AppHandle,
    _owner_label: &str,
    _id: &GuestId,
    _url: &Url,
    _bounds: GuestBounds,
) -> Result<Arc<dyn GuestHost>, BrowserError> {
    Err(BrowserError::unsupported())
}
