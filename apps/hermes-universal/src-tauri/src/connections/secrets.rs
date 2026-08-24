//! Per-connection credential scoping.
//!
//! Two account spaces, and which one a connection uses is decided by ONE
//! predicate — `Registry::legacy_id`:
//!
//!  • the LEGACY owner (the `local` row, or the single connection the migration
//!    minted on a phone) keeps the seven bare `SecretKey` accounts. Nothing is
//!    migrated, nothing is re-requested from the user, and an install that
//!    downgrades to a pre-registry build still finds everything;
//!  • every other connection uses `OwnedKey`'s `conn:<id>/…` accounts, which
//!    have never existed before — so there is nothing to migrate there either.
//!
//! Nothing in here is reachable from IPC. The webview supplies a credential ONCE
//! as a write-only field on `connections_save`, whose id argument is validated
//! against the registry document before any keyring call, and asks only whether
//! one is *set* (a boolean and a four-character preview) afterwards.

use crate::secrets::{self, OwnedKey, SecretKey, SecretsError};

use super::registry::Connection;

/// Which credential of a connection is being named.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectionSecret {
    Token,
    SshKey,
    SshPassphrase,
    SshPassword,
    ReuseToken,
}

impl ConnectionSecret {
    /// The bare account this credential lived in before the registry.
    ///
    /// `ReuseToken` maps onto `Token` on purpose: the pre-registry SSH path
    /// stores the backend's session token in `SecretKey::Token` and reads it
    /// back as the reattach token (`store/connection.ts`'s `saveSecrets({token})`
    /// / `saved?.token`). Keeping that mapping is what makes the legacy owner's
    /// first post-upgrade connect a REUSE rather than a respawn — and splitting
    /// them for every other connection is what fixes D-4, where an ssh reattach
    /// token clobbered a remote gateway's token and vice-versa.
    fn legacy_key(self) -> SecretKey {
        match self {
            Self::Token | Self::ReuseToken => SecretKey::Token,
            Self::SshKey => SecretKey::SshKey,
            Self::SshPassphrase => SecretKey::SshPassphrase,
            Self::SshPassword => SecretKey::SshPassword,
        }
    }

    fn owned_key(self) -> OwnedKey {
        match self {
            Self::Token => OwnedKey::ConnectionToken,
            Self::SshKey => OwnedKey::ConnectionSshKey,
            Self::SshPassphrase => OwnedKey::ConnectionSshPassphrase,
            Self::SshPassword => OwnedKey::ConnectionSshPassword,
            Self::ReuseToken => OwnedKey::ConnectionReuseToken,
        }
    }

    /// Every per-connection credential, for the removal sweep.
    pub fn all() -> [ConnectionSecret; 5] {
        [
            Self::Token,
            Self::SshKey,
            Self::SshPassphrase,
            Self::SshPassword,
            Self::ReuseToken,
        ]
    }
}

/// Where one connection's credentials live. Built from the registry, never from
/// a webview-supplied string.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectionScope {
    pub id: String,
    /// True for the connection that inherited the pre-registry accounts.
    pub legacy: bool,
}

impl ConnectionScope {
    pub fn new(id: impl Into<String>, legacy: bool) -> Self {
        Self {
            id: id.into(),
            legacy,
        }
    }
}

/// Header VALUES are always connection-scoped, even for the legacy owner: the
/// pre-registry app had no extra-header feature at all, so there is no bare
/// account to stay compatible with.
fn header_scope(id: &str, name: &str) -> String {
    format!("{id}/header/{}", name.trim().to_ascii_lowercase())
}

pub fn read(scope: &ConnectionScope, secret: ConnectionSecret) -> Result<Option<String>, SecretsError> {
    if scope.legacy {
        secrets::read(secret.legacy_key())
    } else {
        secrets::read_owned(secret.owned_key(), &scope.id)
    }
}

/// Write, or DELETE when the value is empty — the same equivalence `secrets`
/// itself uses, so clearing a field in the editor clears the credential rather
/// than storing a blank that reads back as a real, wrong one.
pub fn write(scope: &ConnectionScope, secret: ConnectionSecret, value: &str) -> Result<(), SecretsError> {
    if scope.legacy {
        return secrets::write(secret.legacy_key(), value);
    }

    if value.is_empty() {
        secrets::remove_owned(secret.owned_key(), &scope.id)
    } else {
        secrets::write_owned(secret.owned_key(), &scope.id, value)
    }
}

pub fn read_header(id: &str, name: &str) -> Result<Option<String>, SecretsError> {
    secrets::read_owned(OwnedKey::ConnectionHeader, &header_scope(id, name))
}

pub fn write_header(id: &str, name: &str, value: &str) -> Result<(), SecretsError> {
    let scope = header_scope(id, name);

    if value.is_empty() {
        secrets::remove_owned(OwnedKey::ConnectionHeader, &scope)
    } else {
        secrets::write_owned(OwnedKey::ConnectionHeader, &scope, value)
    }
}

/// Forget everything a removed connection owned.
///
/// The LEGACY owner's bare accounts are deliberately NOT swept: they are the
/// app's own credentials, shared with a pre-registry build, and `secrets_clear`
/// (sign out) is the verb that clears those. Header values are swept by NAME,
/// which is why the document keeps the names in plaintext.
pub fn sweep(connection: &Connection, scope: &ConnectionScope) -> Result<(), SecretsError> {
    let mut failure = None;

    if !scope.legacy {
        for secret in ConnectionSecret::all() {
            // Keep going after a failure — stopping at the first would leave the
            // rest of this connection's credentials behind as well as the one
            // that refused.
            if let Err(err) = secrets::remove_owned(secret.owned_key(), &scope.id) {
                failure.get_or_insert(err);
            }
        }
    }

    for name in &connection.header_names {
        if let Err(err) = secrets::remove_owned(OwnedKey::ConnectionHeader, &header_scope(&scope.id, name)) {
            failure.get_or_insert(err);
        }
    }

    match failure {
        Some(err) => Err(err),
        None => Ok(()),
    }
}

/// The last four characters of a token, for "is this the one I pasted?".
///
/// Never more: the preview reaches the settings page, a screenshot and a
/// screen-share, and four characters identify a paste without reconstructing a
/// credential.
pub fn token_preview(token: &str) -> Option<String> {
    let trimmed = token.trim();

    if trimmed.is_empty() {
        return None;
    }

    let chars: Vec<char> = trimmed.chars().collect();
    let tail: String = chars[chars.len().saturating_sub(4)..].iter().collect();

    Some(tail)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_legacy_owner_reuses_the_bare_token_account_for_the_reattach_token() {
        assert_eq!(ConnectionSecret::Token.legacy_key(), SecretKey::Token);
        assert_eq!(ConnectionSecret::ReuseToken.legacy_key(), SecretKey::Token);
        // …but they are DIFFERENT accounts for every other connection, which is
        // the bug (D-4) where an ssh reattach token clobbered a remote token.
        assert_ne!(
            ConnectionSecret::Token.owned_key(),
            ConnectionSecret::ReuseToken.owned_key()
        );
    }

    #[test]
    fn header_scopes_are_lowercased_and_namespaced_per_connection() {
        assert_eq!(header_scope("box", "CF-Access-Client-Id"), "box/header/cf-access-client-id");
        assert_ne!(header_scope("box", "x"), header_scope("other", "x"));
    }

    #[test]
    fn token_preview_is_four_characters_and_nothing_for_a_blank() {
        assert_eq!(token_preview("abcdefghij").as_deref(), Some("ghij"));
        assert_eq!(token_preview("ab").as_deref(), Some("ab"));
        assert_eq!(token_preview("   "), None);
    }
}
