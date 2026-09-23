//! The native WebView guest host for Android and iOS. See Cargo.toml for why it
//! is a plugin rather than part of `src/browser/`.
//!
//! There is deliberately NO `invoke_handler` here: the webview never calls this
//! plugin. The app's own `browser_*` commands are the only door, and they are
//! what the capability file scopes. Exposing `navigate`/`eval` to JS as well
//! would be a second, unscoped way to point a native WebView at a URL.

use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

pub use models::*;

#[cfg(desktop)]
mod desktop;
#[cfg(mobile)]
mod mobile;

mod error;
mod models;

pub use error::{Error, Result};

#[cfg(desktop)]
use desktop::Browser;
#[cfg(mobile)]
use mobile::Browser;

/// Access the native guest host from any [`tauri::Manager`].
pub trait BrowserExt<R: Runtime> {
    fn browser_host(&self) -> &Browser<R>;
}

impl<R: Runtime, T: Manager<R>> crate::BrowserExt<R> for T {
    fn browser_host(&self) -> &Browser<R> {
        self.state::<Browser<R>>().inner()
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("browser")
        .setup(|app, api| {
            #[cfg(mobile)]
            let browser = mobile::init(app, api)?;
            #[cfg(desktop)]
            let browser = desktop::init(app, api)?;
            app.manage(browser);
            Ok(())
        })
        .build()
}
