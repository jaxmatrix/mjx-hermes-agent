use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::models::*;

pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<Browser<R>> {
    Ok(Browser(app.clone()))
}

/// The desktop no-op.
///
/// Desktop's guest is a CHILD WEBVIEW built by `src/browser/desktop.rs`, not a
/// native view, so nothing here is ever called — `src/browser/mod.rs` picks its
/// adapter by `cfg`, and this half exists only so the crate compiles on every
/// target and the builder chain has one shape.
pub struct Browser<R: Runtime>(#[allow(dead_code)] AppHandle<R>);

impl<R: Runtime> Browser<R> {
    fn refuse<T>(&self) -> crate::Result<T> {
        Err(crate::Error::PlatformError(
            "The native WebView host is mobile-only; desktop uses a child webview.".to_string(),
        ))
    }

    pub fn open(&self, _request: OpenRequest) -> crate::Result<()> {
        self.refuse()
    }
    pub fn navigate(&self, _request: NavigateRequest) -> crate::Result<()> {
        self.refuse()
    }
    pub fn back(&self, _request: GuestRequest) -> crate::Result<()> {
        self.refuse()
    }
    pub fn forward(&self, _request: GuestRequest) -> crate::Result<()> {
        self.refuse()
    }
    pub fn reload(&self, _request: GuestRequest) -> crate::Result<()> {
        self.refuse()
    }
    pub fn stop(&self, _request: GuestRequest) -> crate::Result<()> {
        self.refuse()
    }
    pub fn set_bounds(&self, _request: BoundsRequest) -> crate::Result<()> {
        self.refuse()
    }
    pub fn set_visible(&self, _request: VisibleRequest) -> crate::Result<VisibleResponse> {
        self.refuse()
    }
    pub fn eval(&self, _request: EvalRequest) -> crate::Result<EvalResponse> {
        self.refuse()
    }
    pub fn clear_data(&self, _request: GuestRequest) -> crate::Result<()> {
        self.refuse()
    }
    pub fn close(&self, _request: GuestRequest) -> crate::Result<()> {
        self.refuse()
    }
    pub fn capabilities(&self) -> crate::Result<Capabilities> {
        self.refuse()
    }
}
