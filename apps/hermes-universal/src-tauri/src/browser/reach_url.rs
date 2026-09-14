//! PURE loopback-URL arithmetic for the forward lease. Semantics ported from
//! the Electron desktop app's `electron/preview-reach.ts:65-101`.
//!
//! Deliberately NO port allowlist. A dev server listens on whatever the
//! framework picked, and an allowlist just means the next framework's default
//! silently fails. The security boundary is the authenticated SSH transport —
//! we can only ever reach a host we are already authenticated to.

use tauri::Url;

/// The hostnames that mean "the machine this URL was written on".
pub const LOOPBACK_HOSTS: [&str; 4] = ["0.0.0.0", "127.0.0.1", "::1", "localhost"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LoopbackTarget {
    pub port: u16,
}

/// `Some(port)` when this URL names a loopback address the remote side would
/// resolve to itself; `None` for anything else, including a non-http scheme.
pub fn loopback_target(raw: &str) -> Option<LoopbackTarget> {
    let url = Url::parse(raw.trim()).ok()?;

    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }

    // `Url::host_str` keeps the brackets on an IPv6 literal.
    let host = url
        .host_str()?
        .trim_matches(['[', ']'])
        .to_ascii_lowercase();

    if !LOOPBACK_HOSTS.contains(&host.as_str()) {
        return None;
    }

    // `port_or_known_default` supplies 80/443 when the URL omits one.
    let port = url.port_or_known_default()?;

    Some(LoopbackTarget { port })
}

/// Point a loopback URL at OUR end of the tunnel, keeping everything that makes
/// the URL useful.
///
/// The scheme is FORCED to http: a forward carries plain TCP to a dev server
/// that is almost never TLS-terminated, so keeping `https` would hand the guest
/// a handshake failure instead of a page.
pub fn rewrite_to_local_port(raw: &str, local_port: u16) -> Option<String> {
    let mut url = Url::parse(raw.trim()).ok()?;

    loopback_target(raw)?;

    url.set_scheme("http").ok()?;
    url.set_host(Some("127.0.0.1")).ok()?;
    url.set_port(Some(local_port)).ok()?;

    Some(url.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn it_accepts_any_port_not_a_curated_list() {
        // Adding an allowlist must turn this red. A dev server is whatever the
        // framework picked.
        for port in [1u16, 3000, 5173, 8080, 31337, 65535] {
            assert_eq!(
                loopback_target(&format!("http://localhost:{port}/")),
                Some(LoopbackTarget { port }),
                "port {port}"
            );
        }
    }

    #[test]
    fn it_defaults_the_port_by_scheme() {
        assert_eq!(
            loopback_target("http://localhost/"),
            Some(LoopbackTarget { port: 80 })
        );
        assert_eq!(
            loopback_target("https://127.0.0.1/"),
            Some(LoopbackTarget { port: 443 })
        );
    }

    #[test]
    fn it_strips_the_brackets_from_an_ipv6_literal() {
        assert_eq!(
            loopback_target("http://[::1]:8000/x"),
            Some(LoopbackTarget { port: 8000 })
        );
    }

    #[test]
    fn it_ignores_anything_that_is_not_a_loopback_web_url() {
        assert_eq!(loopback_target("https://example.com:8000/"), None);
        assert_eq!(loopback_target("ftp://localhost:21/"), None);
        assert_eq!(loopback_target("file:///tmp/x"), None);
        assert_eq!(loopback_target("not a url"), None);
        assert_eq!(loopback_target(""), None);
        // 0 and 65536 cannot be represented by the parser at all.
        assert_eq!(
            loopback_target("http://localhost:0/"),
            Some(LoopbackTarget { port: 0 })
        );
        assert_eq!(loopback_target("http://localhost:65536/"), None);
    }

    #[test]
    fn it_keeps_path_query_and_hash_and_forces_http() {
        // Deleting the `set_scheme("http")` line must turn this red: a forward
        // carries plain TCP to a dev server that is not TLS-terminated.
        assert_eq!(
            rewrite_to_local_port("https://localhost:5173/a/b?q=1#frag", 41234).as_deref(),
            Some("http://127.0.0.1:41234/a/b?q=1#frag")
        );
    }

    #[test]
    fn it_leaves_a_non_loopback_url_alone() {
        assert_eq!(rewrite_to_local_port("https://example.com/", 41234), None);
    }
}
