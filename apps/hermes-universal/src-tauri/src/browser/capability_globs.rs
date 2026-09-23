//! The pin for the ACL boundary the in-app browser depends on.
//!
//! `capabilities/default.json` is scoped by `webviews`, not `windows`, because
//! Tauri resolves a command with
//! `cmd.webviews.matches(webview) || cmd.windows.matches(window)` — so a
//! `windows` glob would grant the app's whole permission set to a CHILD webview
//! living inside window `main`, which is exactly what the guest is.
//!
//! Two assertions, and both must be able to fail:
//!   * every label `window.rs` can open still matches a glob (a mis-scoped
//!     label gets NO IPC at all, and a missing clipboard grant fails
//!     *silently* — the file's own description says so);
//!   * `guest:*` matches none of them.

/// Tauri's capability globs are `glob` patterns; every one this file uses is
/// either a literal or a `prefix-*`, so a full glob engine would be a
/// dependency to re-check three characters.
fn matches(pattern: &str, label: &str) -> bool {
    match pattern.strip_suffix('*') {
        Some(prefix) => label.starts_with(prefix),
        None => pattern == label,
    }
}

fn scopes() -> Vec<String> {
    let raw = include_str!("../../capabilities/default.json");
    let doc: serde_json::Value = serde_json::from_str(raw).expect("capabilities/default.json");

    let list = doc
        .get("webviews")
        .and_then(|v| v.as_array())
        .expect("the capability must be scoped by `webviews`, not `windows` — see the module note");

    list.iter()
        .map(|v| v.as_str().expect("glob").to_string())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::browser::policy::guest_label;

    #[test]
    fn the_capability_is_scoped_by_webview_not_window() {
        let raw = include_str!("../../capabilities/default.json");
        let doc: serde_json::Value = serde_json::from_str(raw).expect("parse");

        // Reverting `webviews` to `windows` turns this red, and so does merely
        // SUPPLEMENTING it: the hole closes only if `windows` is empty.
        assert!(doc.get("webviews").is_some(), "no `webviews` scope");
        assert!(
            doc.get("windows").is_none(),
            "`windows` must be gone, not merely joined by `webviews`"
        );
    }

    #[test]
    fn every_label_window_rs_can_open_still_gets_ipc() {
        let scopes = scopes();

        for label in [
            "main",
            "instance-2",
            "tile-abc123",
            "tile-session-uuid_1",
            "sat-hud",
            "screen",
        ] {
            assert!(
                scopes.iter().any(|glob| matches(glob, label)),
                "{label} matches no glob — that window would get NO IPC at all"
            );
        }
    }

    #[test]
    fn the_browser_guest_matches_nothing() {
        let scopes = scopes();
        let guest = guest_label(&"browser".to_string());

        // Renaming the guest label to something inside a glob (`main`,
        // `tile-browser`) turns this red. That rename is the whole hole.
        assert!(
            !scopes.iter().any(|glob| matches(glob, &guest)),
            "{guest} matches a capability glob — the guest would inherit the app's ACL"
        );

        for other in ["guest:anything", "guest:tile-x"] {
            assert!(!scopes.iter().any(|glob| matches(glob, other)), "{other}");
        }
    }

    #[test]
    fn the_matcher_itself_is_not_vacuously_true() {
        assert!(matches("sat-*", "sat-hud"));
        assert!(!matches("sat-*", "hud"));
        assert!(matches("main", "main"));
        assert!(!matches("main", "mainx"));
    }
}
