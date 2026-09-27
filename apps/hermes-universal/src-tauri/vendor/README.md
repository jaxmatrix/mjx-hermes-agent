# Vendored crates (Hermès Universal)

## `tao-0.35.3`

- iOS `UISceneConfiguration` retain fix (see Cargo.toml `[patch.crates-io]` comment).
- Linux `WindowExtUnix::content_fixed` (tao#1232): full-window `gtk::Fixed` overlay
  so positioned child webviews can sit over the main UI instead of packing into
  the default vertical `gtk::Box`.

## `wry-0.55.1`

- wry#1745: `set_bounds` on a Fixed-parented webview uses `gtk::Fixed::move_` +
  `set_size_request` so position survives GTK layout passes.

## `tauri-runtime-wry-2.11.4`

- tauri#15463 / tauri#10420: Linux `WebviewKind::WindowChild` builds into
  `window.content_fixed()` instead of `default_vbox()`, so the in-app browser
  guest honors `set_bounds` instead of painting as a bottom strip under the
  main webview.

Remove these patches when upstream tauri/tao/wry releases include the same
fixes and the lockfile can take them without a path override.
