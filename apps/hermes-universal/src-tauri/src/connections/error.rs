//! The registry's structured failure.
//!
//! A `String` error would force the frontend to match on prose: the editor has
//! to tell "that name is taken" (an inline field message) from "this device has
//! no credential store" (a whole different offer) from "the file is from a newer
//! build" (disable every mutation). So the KIND rides on the wire and the
//! message is the human half — recipe 6.1 step 10, the `SshError` /
//! `ContextMenuError` shape.

use serde::Serialize;

#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ConnectionsErrorKind {
    /// `app_data_dir()` is unavailable — the registry is in-memory this run.
    NoDataDir,
    /// Written by a newer build; read-only.
    FutureVersion,
    NotFound,
    DuplicateLabel,
    /// The same URL, or the same `user@host:port` + remote profile.
    DuplicateTarget,
    /// `{id: "local"}` on anything but the local kind.
    ReservedId,
    /// A `local` entry on a device that cannot host one.
    LocalUnsupported,
    LocalNotRemovable,
    RegistryFull,
    /// A field failed normalization; the message names it.
    InvalidInput,
    /// A credential-bearing save with no credential store to put it in.
    KeyringUnavailable,
    WriteFailed,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionsError {
    pub kind: ConnectionsErrorKind,
    pub message: String,
}

impl ConnectionsError {
    pub fn new(kind: ConnectionsErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(ConnectionsErrorKind::InvalidInput, message)
    }

    pub fn not_found(id: &str) -> Self {
        Self::new(
            ConnectionsErrorKind::NotFound,
            format!("no gateway with id \"{id}\""),
        )
    }

    pub fn write_failed(message: impl Into<String>) -> Self {
        Self::new(ConnectionsErrorKind::WriteFailed, message)
    }
}

impl std::fmt::Display for ConnectionsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for ConnectionsError {}
