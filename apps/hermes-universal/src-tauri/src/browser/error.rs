//! A STRUCTURED browser error, because the frontend branches on it.
//!
//! `ssh::error::SshError` is the precedent: a `String` would force the pane to
//! match on prose to tell "this platform has no guest" from "the page did not
//! answer in time", and those two produce completely different UI.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserError {
    pub kind: BrowserErrorKind,
    pub message: String,
}

// The reach kinds are constructed by the TS side's error mapping, not here —
// `browser_reach_url` reports through `ReachNote` instead of failing. They stay
// in the enum because they are the wire contract the frontend branches on.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum BrowserErrorKind {
    /// No guest host on this target at all.
    UnsupportedPlatform,
    /// The platform has a host, but building it refused.
    HostBuildFailed,
    NoSuchGuest,
    /// `policy::navigation_allowed` said no.
    BlockedScheme,
    EvalTimeout,
    EvalTooLarge,
    /// Reach only — the active connection is not SSH-backed.
    NotSshBacked,
    /// Reach only — `ssh::forward::open` failed.
    ForwardFailed,
    /// Reach only — the session that authorised the lease died mid-open.
    ConnectionGone,
}

impl BrowserError {
    pub fn new(kind: BrowserErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    pub fn unsupported() -> Self {
        Self::new(
            BrowserErrorKind::UnsupportedPlatform,
            "This build has no in-app browser host on this platform.",
        )
    }

    pub fn no_such_guest(id: &str) -> Self {
        Self::new(
            BrowserErrorKind::NoSuchGuest,
            format!("No in-app browser guest named {id:?} is open."),
        )
    }
}

impl std::fmt::Display for BrowserError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for BrowserError {}
