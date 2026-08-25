use serde::de::DeserializeOwned;
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::models::*;

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_browser);

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<Browser<R>> {
    #[cfg(target_os = "android")]
    let handle =
        api.register_android_plugin("com.nousresearch.hermes.plugin.browser", "BrowserPlugin")?;
    #[cfg(target_os = "ios")]
    let handle = api.register_ios_plugin(init_plugin_browser)?;

    Ok(Browser(handle))
}

/// The native `WebView` / `WKWebView` guest, driven over the mobile plugin
/// bridge. Every call is a `run_mobile_plugin`, which blocks the calling thread
/// until the native side resolves — `src/browser/mobile.rs` is what keeps that
/// off an async task.
pub struct Browser<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> Browser<R> {
    pub fn open(&self, request: OpenRequest) -> crate::Result<()> {
        self.0
            .run_mobile_plugin("open", request)
            .map_err(Into::into)
    }
    pub fn navigate(&self, request: NavigateRequest) -> crate::Result<()> {
        self.0
            .run_mobile_plugin("navigate", request)
            .map_err(Into::into)
    }
    pub fn back(&self, request: GuestRequest) -> crate::Result<()> {
        self.0
            .run_mobile_plugin("back", request)
            .map_err(Into::into)
    }
    pub fn forward(&self, request: GuestRequest) -> crate::Result<()> {
        self.0
            .run_mobile_plugin("forward", request)
            .map_err(Into::into)
    }
    pub fn reload(&self, request: GuestRequest) -> crate::Result<()> {
        self.0
            .run_mobile_plugin("reload", request)
            .map_err(Into::into)
    }
    pub fn stop(&self, request: GuestRequest) -> crate::Result<()> {
        self.0
            .run_mobile_plugin("stop", request)
            .map_err(Into::into)
    }
    pub fn set_bounds(&self, request: BoundsRequest) -> crate::Result<()> {
        self.0
            .run_mobile_plugin("setBounds", request)
            .map_err(Into::into)
    }
    pub fn set_visible(&self, request: VisibleRequest) -> crate::Result<VisibleResponse> {
        self.0
            .run_mobile_plugin("setVisible", request)
            .map_err(Into::into)
    }
    pub fn eval(&self, request: EvalRequest) -> crate::Result<EvalResponse> {
        self.0
            .run_mobile_plugin("eval", request)
            .map_err(Into::into)
    }
    pub fn clear_data(&self, request: GuestRequest) -> crate::Result<()> {
        self.0
            .run_mobile_plugin("clearData", request)
            .map_err(Into::into)
    }
    pub fn close(&self, request: GuestRequest) -> crate::Result<()> {
        self.0
            .run_mobile_plugin("close", request)
            .map_err(Into::into)
    }
    pub fn capabilities(&self) -> crate::Result<Capabilities> {
        self.0
            .run_mobile_plugin("capabilities", ())
            .map_err(Into::into)
    }
}
