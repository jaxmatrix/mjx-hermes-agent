//! The OS credential store, spoken to directly.
//!
//! This replaces a vendored copy of `charlesportwoodii/tauri-plugin-keyring`.
//! Two reasons it is ours now, and both matter:
//!
//! 1. **Licensing.** That repository carries no license file at all, which under
//!    default copyright means no grant to redistribute it — not something to
//!    discover during a release audit. Everything it wrapped (`keyring-core` and
//!    the four `*-native-keyring-store` crates) is MIT/Apache-2.0, so talking to
//!    them directly removes the problem rather than papering over it.
//! 2. **Reach.** Binding a credential to a device unlock needs `kSecAccessControl`
//!    on Apple and a `setUserAuthenticationRequired` Keystore key on Android —
//!    neither of which a generic get/set wrapper can express. Owning this layer
//!    is what makes that possible at all.
//!
//! The entry naming is deliberately byte-identical to what the plugin wrote, so
//! an install that upgrades into this build finds its existing credentials
//! exactly where it left them. Changing the shape here silently orphans every
//! stored token, key and password — there is no migration, because there does
//! not need to be one.

use std::sync::{Arc, Mutex};

use keyring_core::{CredentialStore, Entry};

use super::error::SecretsError;

/// The OS credential group everything lives under. One service means one thing
/// for the user to find, inspect and revoke.
pub const SERVICE: &str = "hermes";

/// Whether the process-wide default store has been installed.
///
/// A `Mutex<bool>` rather than a `OnceLock`, because failure must stay
/// retryable. On Android the store cannot be built until `ndk_context` has been
/// populated from the Java side, and caching that one early failure forever
/// would disable credential storage for the whole run.
static READY: Mutex<bool> = Mutex::new(false);

/// A store an EARLIER build wrote credentials to, still consulted on read.
///
/// Only macOS has one: it used to select the Protected Data keychain, and now uses
/// the login keychain (see `install`). A credential found only here is adopted —
/// copied into the current store, read back, and only then deleted from here — so
/// switching stores can never be what signs someone out. `None` everywhere else,
/// and cleared for the rest of the run the first time the legacy store refuses a
/// call, because a store that cannot be read cannot be holding anything we wrote.
static LEGACY: Mutex<Option<Arc<CredentialStore>>> = Mutex::new(None);

fn legacy_store() -> Option<Arc<CredentialStore>> {
    LEGACY
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

fn set_legacy_store(store: Option<Arc<CredentialStore>>) {
    *LEGACY
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = store;
}

/// Install the platform store, once.
pub fn ensure() -> Result<(), SecretsError> {
    let mut ready = READY
        .lock()
        // A panic in another holder says nothing about the store itself.
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    if *ready {
        return Ok(());
    }

    install()?;
    *ready = true;

    Ok(())
}

/// Build the right store for this platform and make it the default.
///
/// There is deliberately no in-memory fallback and no environment-variable
/// escape hatch. The plugin had both, and the escape hatch was read in release
/// builds — so a single env var sent every session token, SSH private key and
/// password to process memory instead of the keychain, reporting success the
/// whole way. "Nothing is being stored" has to be a visible failure.
//
// The explicit `return` in each arm is load-bearing, not stylistic: exactly one
// arm survives `cfg` evaluation, and without it the surviving block's value
// would be a statement with nothing to fall through to.
#[allow(clippy::needless_return)]
fn install() -> Result<(), SecretsError> {
    #[cfg(test)]
    {
        let store = keyring_core::mock::Store::new()
            .map_err(|e| SecretsError::unavailable(format!("mock store: {e}")))?;
        keyring_core::set_default_store(store);

        return Ok(());
    }

    // The two Apple targets take different stores, and the split is load-bearing.
    //
    // The Protected Data keychain writes with `kSecUseDataProtectionKeychain`, which
    // needs the process to carry a keychain access group. That comes from a
    // `keychain-access-groups`/`application-identifier` entitlement, i.e. from a
    // provisioning profile. iOS always has one; a macOS bundle only has one if it is
    // signed with a profile, and this one is not (no `bundle.macOS` in
    // tauri.conf.json, and `tauri dev` runs a bare binary). Using it there returned
    // `errSecMissingEntitlement (-34018)` on every single write.
    //
    // That failure was invisible from here: `protected::Store::new()` is infallible,
    // so `ensure` succeeded and `secrets_status` advertised a working store while
    // nothing could be written to it. What it looked like from the outside was a
    // desktop sign-in that finished and left the app signed out —
    // `oauth.rs::store_native_tokens` could not persist the token set.
    #[cfg(all(not(test), target_os = "macos"))]
    {
        // The file-based login keychain. Available to any process, entitlement or not.
        let store = apple_native_keyring_store::keychain::Store::new()
            .map_err(|e| SecretsError::unavailable(format!("the Keychain is unavailable: {e}")))?;
        keyring_core::set_default_store(store);

        // The store earlier builds selected. Read-only from here on: see `LEGACY`.
        if let Ok(previous) = apple_native_keyring_store::protected::Store::new() {
            set_legacy_store(Some(previous as Arc<CredentialStore>));
        }

        return Ok(());
    }

    #[cfg(all(not(test), target_os = "ios"))]
    {
        // The `protected` store is the Protected Data keychain, and is required
        // on iOS — the crate errors without it.
        let store = apple_native_keyring_store::protected::Store::new()
            .map_err(|e| SecretsError::unavailable(format!("the Keychain is unavailable: {e}")))?;
        keyring_core::set_default_store(store);

        return Ok(());
    }

    #[cfg(all(not(test), target_os = "windows"))]
    {
        let store = windows_native_keyring_store::Store::new().map_err(|e| {
            SecretsError::unavailable(format!("Credential Manager is unavailable: {e}"))
        })?;
        keyring_core::set_default_store(store);

        return Ok(());
    }

    #[cfg(all(not(test), target_os = "linux"))]
    {
        // A desktop with no Secret Service provider running (no gnome-keyring,
        // no kwallet) lands here. That is a real "we will not persist
        // credentials" answer, not an error to swallow.
        let store = dbus_secret_service_keyring_store::Store::new().map_err(|e| {
            SecretsError::unavailable(format!(
                "no Secret Service is available on this session: {e}. Credentials will not be \
                 saved. Start a keyring daemon (gnome-keyring or kwallet) and try again."
            ))
        })?;
        keyring_core::set_default_store(store);

        return Ok(());
    }

    #[cfg(all(not(test), target_os = "android"))]
    {
        // Reads the Context/JavaVM out of the global `ndk_context`, which Tauri
        // does NOT populate. MainActivity does, via the crate's own JNI entry
        // point — see `gen/android/.../KeyringInit.kt`. Because this runs lazily
        // on first use, the WebView (and therefore that call) already exists.
        let store = android_native_keyring_store::Store::new().map_err(|e| {
            SecretsError::unavailable(format!("the Android Keystore is unavailable: {e}"))
        })?;
        keyring_core::set_default_store(store);

        return Ok(());
    }

    #[cfg(all(
        not(test),
        not(any(
            target_os = "macos",
            target_os = "ios",
            target_os = "windows",
            target_os = "linux",
            target_os = "android"
        ))
    ))]
    Err(SecretsError::unavailable(
        "this platform has no OS credential store",
    ))
}

/// The account one entry lives under.
///
/// `hermes/<account>/password`, inside the `hermes` service. The redundant
/// service prefix and the trailing type are the plugin's format, kept verbatim:
/// they are what an already-installed copy of Hermes wrote, and the whole point
/// of matching is that upgrading finds its credentials rather than losing them.
fn entry(account: &str) -> Result<Entry, SecretsError> {
    ensure()?;

    Entry::new(SERVICE, &user(account))
        .map_err(|e| SecretsError::store_failed(format!("the keyring refused the entry: {e}")))
}

fn user(account: &str) -> String {
    format!("{SERVICE}/{account}/password")
}

/// The same entry in the legacy store, when this platform has one.
fn legacy_entry(account: &str) -> Option<Entry> {
    let store = legacy_store()?;

    match store.build(SERVICE, &user(account), None) {
        Ok(entry) => Some(entry),
        Err(e) => {
            log::warn!("[secrets] the previous credential store refused an entry: {e}");
            set_legacy_store(None);

            None
        }
    }
}

/// Move one credential out of the legacy store, returning its value.
///
/// The order is the whole point: write to the current store, read it back, and
/// delete the legacy copy only once the read-back matches. Any failure on the way
/// leaves the legacy copy exactly where it was — the value is still returned, so
/// this run works, and the next read simply tries again. Deleting first, or
/// deleting on an unverified write, would turn one keychain hiccup into a lost
/// credential.
fn adopt_legacy(current: &Entry, legacy: &Entry) -> Option<String> {
    let value = match legacy.get_password() {
        Ok(value) => value,
        Err(keyring_core::Error::NoEntry) => return None,
        Err(e) => {
            // On macOS without a keychain access group this is -34018. A store we
            // cannot read cannot be holding anything we managed to write, so stop
            // asking for the rest of the run instead of paying for it on every read.
            log::warn!("[secrets] the previous credential store is unreadable: {e}");
            set_legacy_store(None);

            return None;
        }
    };

    if let Err(e) = current.set_password(&value) {
        log::warn!("[secrets] could not move a credential out of the previous store: {e}");

        return Some(value);
    }

    match current.get_password() {
        Ok(read_back) if read_back == value => {
            if let Err(e) = legacy.delete_credential() {
                log::warn!("[secrets] moved a credential but could not delete the old copy: {e}");
            }
        }
        _ => log::warn!("[secrets] a moved credential did not read back; keeping the old copy"),
    }

    Some(value)
}

/// Read one entry. A missing entry is `None`, not an error.
///
/// One round trip. The old JS shim asked `has_password` and then `get_password`,
/// which is two IPC hops and a window in which the answer can change between
/// them — for no gain, since "not there" is exactly what `NoEntry` means.
pub fn read(account: &str) -> Result<Option<String>, SecretsError> {
    let current = entry(account)?;

    match current.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring_core::Error::NoEntry) => {
            Ok(legacy_entry(account).and_then(|legacy| adopt_legacy(&current, &legacy)))
        }
        Err(e) => Err(SecretsError::store_failed(format!(
            "the keyring refused the read: {e}"
        ))),
    }
}

pub fn write(account: &str, value: &str) -> Result<(), SecretsError> {
    entry(account)?
        .set_password(value)
        .map_err(|e| SecretsError::store_failed(format!("the keyring refused the write: {e}")))
}

/// Delete one entry. Already-absent counts as deleted.
///
/// Every other failure is reported. A wipe that quietly failed used to be
/// indistinguishable from one that worked, which is the worst possible answer
/// for the one operation whose entire job is that the credential is gone.
pub fn remove(account: &str) -> Result<(), SecretsError> {
    match entry(account)?.delete_credential() {
        Ok(()) | Err(keyring_core::Error::NoEntry) => {}
        Err(e) => {
            return Err(SecretsError::store_failed(format!(
                "the keyring refused the delete: {e}"
            )))
        }
    }

    // The legacy copy goes too, or the next read would adopt it straight back and
    // undo a sign-out. A legacy store that refuses is dropped for the run instead of
    // failing the delete: on macOS it refuses everything, and holds nothing.
    if let Some(legacy) = legacy_entry(account) {
        match legacy.delete_credential() {
            Ok(()) | Err(keyring_core::Error::NoEntry) => {}
            Err(e) => {
                log::warn!("[secrets] the previous credential store refused a delete: {e}");
                set_legacy_store(None);
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use keyring_core::api::CredentialStoreApi;
    use keyring_core::mock;

    use super::*;

    const ACCOUNT: &str = "nativeAuth:https://gw.example.com";

    fn entries() -> (Entry, Entry) {
        let current = mock::Store::new().unwrap();
        let legacy = mock::Store::new().unwrap();

        (
            current.build(SERVICE, &user(ACCOUNT), None).unwrap(),
            legacy.build(SERVICE, &user(ACCOUNT), None).unwrap(),
        )
    }

    #[test]
    fn a_credential_stored_by_an_earlier_build_survives_the_store_switch() {
        let (current, legacy) = entries();
        legacy.set_password("stored-before-the-upgrade").unwrap();

        assert_eq!(
            adopt_legacy(&current, &legacy).as_deref(),
            Some("stored-before-the-upgrade")
        );
        // Moved, not copied: it now lives in the current store…
        assert_eq!(current.get_password().unwrap(), "stored-before-the-upgrade");
        // …and the legacy copy is gone only because the move was verified.
        assert!(matches!(
            legacy.get_password(),
            Err(keyring_core::Error::NoEntry)
        ));
    }

    #[test]
    fn a_failed_write_never_deletes_the_legacy_copy() {
        let (current, legacy) = entries();
        legacy.set_password("only-copy").unwrap();

        let cred: &mock::Cred = current.as_any().downcast_ref().unwrap();
        cred.set_error(keyring_core::Error::BadStoreFormat("refused".to_string()));

        // The value still reaches the caller for this run…
        assert_eq!(
            adopt_legacy(&current, &legacy).as_deref(),
            Some("only-copy")
        );
        // …and the one copy that exists is untouched, so the next read retries.
        assert_eq!(legacy.get_password().unwrap(), "only-copy");
    }

    #[test]
    fn nothing_in_the_legacy_store_reads_as_nothing() {
        let (current, legacy) = entries();

        assert_eq!(adopt_legacy(&current, &legacy), None);
        assert!(matches!(
            current.get_password(),
            Err(keyring_core::Error::NoEntry)
        ));
    }

    #[test]
    fn read_adopts_and_remove_clears_both_stores() {
        let _guard = crate::secrets::gate::test_guard();
        let previous = mock::Store::new().unwrap();
        let account = "store-test-legacy";

        previous
            .build(SERVICE, &user(account), None)
            .unwrap()
            .set_password("from-the-old-store")
            .unwrap();
        set_legacy_store(Some(previous.clone() as Arc<CredentialStore>));

        // The current store has nothing, so the read has to come through the
        // legacy one — and leave the credential in the current store behind it.
        remove_current_only(account);
        assert_eq!(
            read(account).unwrap().as_deref(),
            Some("from-the-old-store")
        );
        assert_eq!(
            entry(account).unwrap().get_password().unwrap(),
            "from-the-old-store"
        );

        // A sign-out that left the legacy copy behind would be undone by the very
        // next read, which would adopt it straight back.
        previous
            .build(SERVICE, &user(account), None)
            .unwrap()
            .set_password("stale-legacy-copy")
            .unwrap();
        remove(account).unwrap();
        assert_eq!(read(account).unwrap(), None);

        set_legacy_store(None);
    }

    fn remove_current_only(account: &str) {
        match entry(account).unwrap().delete_credential() {
            Ok(()) | Err(keyring_core::Error::NoEntry) => {}
            Err(e) => panic!("{e}"),
        }
    }
}
