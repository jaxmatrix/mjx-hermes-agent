// Desktop dev entrypoint. On Android the app is launched through the generated
// mobile entry (lib.rs `run()` + the `mobile_entry_point` macro), not this.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Dev-only: expose WebKitGTK's remote inspector so you can attach Chrome
    // DevTools at http://127.0.0.1:2222 (the embedded inspector hangs). This is
    // the app-process env var that actually drives the webview — tauri.conf.json
    // can't set it (beforeDevCommand only runs Vite). Debug + Linux only, and
    // only when not already set, so you can override the port from the shell.
    // Must run before the webview initializes (i.e. before `run()`).
    #[cfg(all(debug_assertions, target_os = "linux"))]
    if std::env::var_os("WEBKIT_INSPECTOR_SERVER").is_none() {
        std::env::set_var("WEBKIT_INSPECTOR_SERVER", "127.0.0.1:2222");
    }

    #[cfg(all(debug_assertions, target_os = "linux"))]
    if std::env::var_os("WEBKIT_DISABLE_COMPOSITING_MODE").is_none() {
        std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
    }

    hermes_universal_lib::run()
}
