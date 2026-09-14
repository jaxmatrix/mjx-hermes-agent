//! PURE navigation policy for the guest webview. No webview, no Tauri handle —
//! so it unit-tests on a build machine with no display server (rule 35).
//!
//! This is the security boundary described in the design's §11.1. Tauri v2
//! resolves a command's ACL with `cmd.webviews.matches(webview) ||
//! cmd.windows.matches(window)` (`tauri/src/ipc/authority.rs`), and an
//! app-defined `#[tauri::command]` is only ACL-checked when the origin is
//! REMOTE. A child webview that ever reaches a *local* origin inside window
//! `main` would therefore inherit the whole app's permission set. Two of the
//! three defences live here: this guard, and the guest label that
//! `capabilities/default.json`'s `webviews` globs deliberately do not match.

use tauri::Url;

use super::GuestId;

/// What the host should do with a URL the guest tried to reach.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NavVerdict {
    /// An ordinary web page. Let it load.
    Allow,
    /// Not a web page, but a handoff the OS owns — `mailto:`, `tel:`, `magnet:`.
    /// A link to the mail client is not an error, so it is not reported as one.
    External,
    /// Refused, and the refusal is the point: a scheme that could reach the
    /// app's own origin, its custom protocols, or the local filesystem.
    Refuse,
    /// The guest asking the host to do something on its behalf — the ONE
    /// guest→host push channel on desktop (see `GUEST_COMMAND_SCHEME`).
    Command(String),
}

/// The scheme the injected engine navigates to when it needs the host.
///
/// A child webview is deliberately denied the Tauri IPC bridge, and
/// `eval_with_callback` only pulls host→guest, so without this there is no way
/// for an in-page gesture (the context menu's "open in system browser") to
/// reach Rust. Setting `location.href` to this scheme is refused by the guard
/// below — the guest never navigates — and the payload is handed to the host
/// as an ordinary, fully untrusted string.
pub const GUEST_COMMAND_SCHEME: &str = "hermes-guest";

/// Schemes that must never load in the guest.
///
/// `file:`/`view-source:`/`blob:`/`data:` are a divergence from the Electron
/// desktop app, which allowed them on the grounds that "this IS a browser and
/// the person typing already owns the machine". Universal's guest is a webview
/// inside *our* process, and Tauri's `is_local_url` turns an app-origin or
/// custom-scheme document into a LOCAL origin that inherits the window's ACL —
/// so the same reasoning does not survive the port.
const REFUSED_SCHEMES: &[&str] = &[
    "asset",
    "blob",
    "chrome",
    "data",
    "devtools",
    "file",
    "hermes-artifact",
    "hermes-media",
    "ipc",
    "javascript",
    "tauri",
    "view-source",
];

/// Origins the app itself is served from. A guest that reaches one of these is
/// a local origin inside our window, which is exactly the hole this closes.
const APP_ORIGIN_HOSTS: &[&str] = &[
    "tauri.localhost",
    "hermes-artifact.localhost",
    "hermes-media.localhost",
];

/// Is this URL the app's own document (or one of its custom-scheme origins)?
pub fn is_app_origin(url: &Url) -> bool {
    let scheme = url.scheme().to_ascii_lowercase();

    if scheme == "tauri" || scheme.starts_with("hermes-") {
        return true;
    }

    // Windows serves the app over `http://tauri.localhost`, so a plain scheme
    // check is not enough there.
    match url.host_str() {
        Some(host) => APP_ORIGIN_HOSTS.contains(&host.to_ascii_lowercase().as_str()),
        None => false,
    }
}

/// The one gate every navigation passes, wherever it came from: the address
/// bar, a link click, a redirect, `window.location`, or a `preview.open`.
pub fn navigation_allowed(url: &Url) -> NavVerdict {
    let scheme = url.scheme().to_ascii_lowercase();

    if scheme == GUEST_COMMAND_SCHEME {
        // Everything after the scheme, undecoded. The caller treats it as
        // hostile input — it is authored by whatever page is loaded.
        return NavVerdict::Command(url.as_str()[GUEST_COMMAND_SCHEME.len() + 1..].to_string());
    }

    if REFUSED_SCHEMES.contains(&scheme.as_str()) {
        return NavVerdict::Refuse;
    }

    if scheme == "about" {
        // `about:blank` is the empty state the pane opens on. Nothing else in
        // the `about:` space is ours to show.
        return if url.as_str().eq_ignore_ascii_case("about:blank") {
            NavVerdict::Allow
        } else {
            NavVerdict::Refuse
        };
    }

    if scheme == "http" || scheme == "https" {
        return if is_app_origin(url) {
            NavVerdict::Refuse
        } else {
            NavVerdict::Allow
        };
    }

    // `mailto:`, `tel:`, `magnet:`, an installed app's scheme — the OS knows
    // what to do with these and we do not.
    NavVerdict::External
}

/// The guest webview's label.
///
/// MUST stay outside every glob in `capabilities/default.json` — that is the
/// ACL boundary, and `capabilities.rs`'s test is what keeps it one.
pub fn guest_label(id: &GuestId) -> String {
    format!("guest:{id}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn verdict(raw: &str) -> NavVerdict {
        navigation_allowed(&Url::parse(raw).expect("parse"))
    }

    #[test]
    fn ordinary_web_pages_load() {
        assert_eq!(verdict("https://example.com/a?b=1#c"), NavVerdict::Allow);
        assert_eq!(verdict("http://localhost:5173/"), NavVerdict::Allow);
        assert_eq!(verdict("about:blank"), NavVerdict::Allow);
        assert_eq!(verdict("ABOUT:BLANK"), NavVerdict::Allow);
    }

    #[test]
    fn every_origin_reaching_scheme_is_refused() {
        // Neutralising `navigation_allowed` to `Allow` must turn this list red:
        // it is the whole §11.1 boundary.
        for raw in [
            "file:///etc/passwd",
            "blob:https://example.com/abc",
            "data:text/html,<script>1</script>",
            "javascript:alert(1)",
            "tauri://localhost/index.html",
            "hermes-media://localhost/x.png",
            "hermes-artifact://localhost/abc",
            "asset://localhost/x",
            "ipc://localhost",
            "view-source:https://example.com",
            "chrome://settings",
            "devtools://devtools/bundled/inspector.html",
            "about:config",
        ] {
            assert_eq!(verdict(raw), NavVerdict::Refuse, "{raw}");
        }
    }

    #[test]
    fn the_schemes_are_matched_case_insensitively() {
        assert_eq!(verdict("FILE:///etc/passwd"), NavVerdict::Refuse);
        assert_eq!(verdict("JavaScript:alert(1)"), NavVerdict::Refuse);
    }

    #[test]
    fn the_apps_own_http_origin_is_refused_too() {
        // Windows serves the app over http://tauri.localhost — reaching it
        // makes the guest a LOCAL origin, which is the hole.
        assert_eq!(
            verdict("http://tauri.localhost/index.html"),
            NavVerdict::Refuse
        );
        assert_eq!(
            verdict("https://hermes-media.localhost/x"),
            NavVerdict::Refuse
        );
        // A site that merely CONTAINS the string is a different host.
        assert_eq!(
            verdict("https://not-tauri.localhost.example.com/"),
            NavVerdict::Allow
        );
    }

    #[test]
    fn a_handoff_scheme_is_not_a_failure() {
        assert_eq!(verdict("mailto:someone@example.com"), NavVerdict::External);
        assert_eq!(verdict("tel:+15551234"), NavVerdict::External);
    }

    #[test]
    fn the_guest_command_channel_never_navigates() {
        assert_eq!(
            verdict("hermes-guest:open?url=https%3A%2F%2Fexample.com"),
            NavVerdict::Command("open?url=https%3A%2F%2Fexample.com".to_string())
        );
    }

    #[test]
    fn the_guest_label_is_namespaced() {
        // The capability globs are main/session-*/instance-*/tile-*/sat-*/screen.
        // Renaming this to `main` must turn `capabilities.rs`'s test red.
        assert_eq!(guest_label(&"browser".to_string()), "guest:browser");
    }
}
