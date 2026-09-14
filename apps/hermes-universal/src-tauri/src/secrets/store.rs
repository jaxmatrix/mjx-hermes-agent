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
//!
//! ## macOS: one item, and a vault
//!
//! Everywhere else, one secret is one item in the OS store and the paragraphs
//! above describe the whole design. macOS differs because of how it authorizes
//! access. Each login-keychain item carries an ACL checked PER ITEM and PER
//! DIRECTION, and an ACL binds to the requesting code's designated requirement,
//! which an ad-hoc signed bundle does not have (see [`super::code_identity`]). On
//! such a build every check is a password dialog: two stored credentials cost
//! four dialogs a launch.
//!
//! So on macOS this store keeps exactly one keychain item — [`MASTER_KEY_ACCOUNT`],
//! a random 32-byte key — and every secret lives in `<app data dir>/secrets.vault`,
//! sealed by it (see [`super::vault`]). One ACL check per launch however many
//! credentials there are.
//!
//! Credentials an earlier build stored as items move into the vault lazily, per
//! account on first read: the per-item login-keychain entry, then the Protected
//! Data store an even earlier macOS build selected (see [`LEGACY`]). The old item
//! is deleted only after the vault has been re-read and holds the value — never
//! before. Nothing here can enumerate a service, and `nativeAuth:<gateway>` /
//! `conn:<id>/…` accounts are named after gateways and connections this process
//! may not have seen yet, which is why it is lazy.

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

/// The account the vault's master key is stored under, inside [`SERVICE`].
///
/// On macOS this is the ONLY keychain item this app keeps, and it is not a
/// credential — it is the key that seals every credential. Public so `mod.rs` can
/// assert nothing nameable lands on it: routing a secret onto this account would
/// hand out the key to all of them, and a sign-out would delete it and orphan the
/// whole vault.
#[cfg(any(test, target_os = "macos"))]
pub const MASTER_KEY_ACCOUNT: &str = "vaultKey";

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
#[cfg_attr(all(not(test), target_os = "macos"), allow(dead_code))]
fn keychain_read(account: &str) -> Result<Option<String>, SecretsError> {
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

#[cfg_attr(all(not(test), target_os = "macos"), allow(dead_code))]
fn keychain_write(account: &str, value: &str) -> Result<(), SecretsError> {
    entry(account)?
        .set_password(value)
        .map_err(|e| SecretsError::store_failed(format!("the keyring refused the write: {e}")))
}

/// Delete one entry. Already-absent counts as deleted.
///
/// Every other failure is reported. A wipe that quietly failed used to be
/// indistinguishable from one that worked, which is the worst possible answer
/// for the one operation whose entire job is that the credential is gone.
fn keychain_remove(account: &str) -> Result<(), SecretsError> {
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

// --------------------------------------------------------------------------
// The public API, and which tier answers it
// --------------------------------------------------------------------------
//
// Everywhere but macOS, one secret is one item and these are the keychain
// functions above. On a real macOS build they go through the vault. Under
// `cargo test` they deliberately do NOT: the tests below drive the keychain tier
// against `keyring_core::mock`, and `vault_tests` drive `vaulted::Vault` directly.

/// Read one entry. A missing entry is `None`, not an error.
///
/// One round trip. The old JS shim asked `has_password` and then `get_password`,
/// which is two IPC hops and a window in which the answer can change between
/// them — for no gain, since "not there" is exactly what `NoEntry` means.
#[allow(clippy::needless_return)]
pub fn read(account: &str) -> Result<Option<String>, SecretsError> {
    #[cfg(all(not(test), target_os = "macos"))]
    {
        return vaulted::with_global(|vault| vault.read(account));
    }

    #[cfg(not(all(not(test), target_os = "macos")))]
    {
        return keychain_read(account);
    }
}

#[allow(clippy::needless_return)]
pub fn write(account: &str, value: &str) -> Result<(), SecretsError> {
    #[cfg(all(not(test), target_os = "macos"))]
    {
        return vaulted::with_global(|vault| vault.write(account, value));
    }

    #[cfg(not(all(not(test), target_os = "macos")))]
    {
        return keychain_write(account, value);
    }
}

/// Delete one entry. Already-absent counts as deleted.
///
/// Every other failure is reported. A wipe that quietly failed used to be
/// indistinguishable from one that worked, which is the worst possible answer
/// for the one operation whose entire job is that the credential is gone.
#[allow(clippy::needless_return)]
pub fn remove(account: &str) -> Result<(), SecretsError> {
    #[cfg(all(not(test), target_os = "macos"))]
    {
        return vaulted::with_global(|vault| vault.remove(account));
    }

    #[cfg(not(all(not(test), target_os = "macos")))]
    {
        return keychain_remove(account);
    }
}

/// Tell the store where the sealed vault lives.
///
/// Called from the Tauri `setup` hook, before any command can be dispatched. A
/// macOS read or write that arrives before it is refused rather than answered
/// from the wrong place. A no-op off macOS, so the caller needs no `cfg`.
pub fn configure(app_data_dir: std::path::PathBuf) {
    #[cfg(all(not(test), target_os = "macos"))]
    {
        vaulted::configure(app_data_dir);
    }

    #[cfg(not(all(not(test), target_os = "macos")))]
    {
        let _ = app_data_dir;
    }
}

// --------------------------------------------------------------------------
// The vault tier
// --------------------------------------------------------------------------

/// One keychain item, and a sealed file holding everything else.
///
/// Compiled under `cfg(test)` on every platform as well as on macOS, so the
/// migration — the part with a real chance of orphaning a credential — is tested
/// on the machine doing the review rather than only on the one shipping it.
#[cfg(any(test, target_os = "macos"))]
mod vaulted {
    use std::collections::HashSet;
    use std::path::{Path, PathBuf};
    #[cfg(not(test))]
    use std::sync::Mutex;

    use super::super::vault;
    use super::{
        entry, keychain_remove, legacy_entry, set_legacy_store, SecretsError, MASTER_KEY_ACCOUNT,
    };

    /// The vault, once its key has been fetched.
    pub struct Vault {
        path: PathBuf,
        key: vault::MasterKey,
        /// Accounts already looked for outside the vault and not found, so a
        /// credential the user never set does not cost keychain round trips (each
        /// an ACL check on macOS) on every read, forever.
        checked: HashSet<String>,
    }

    impl Vault {
        pub fn new(dir: &Path, key: vault::MasterKey) -> Self {
            Self {
                path: dir.join(vault::FILE_NAME),
                key,
                checked: HashSet::new(),
            }
        }

        /// Read one account: the vault first, then the stores earlier builds wrote
        /// items to, migrating what it finds.
        pub fn read(&mut self, account: &str) -> Result<Option<String>, SecretsError> {
            let mut map = vault::load(&self.key, &self.path)?;

            if let Some(value) = map.get(account) {
                return Ok(Some(value.clone()));
            }

            if self.checked.contains(account) {
                return Ok(None);
            }

            let Some(value) = find_outside(account)? else {
                self.checked.insert(account.to_string());

                return Ok(None);
            };

            map.insert(account.to_string(), value.clone());

            // Best-effort, and ordered so a failure can never lose the only copy:
            // save, re-read the vault, and only when the re-read holds exactly this
            // value delete the old item. A save or verify that fails returns the
            // credential for this run and leaves the item where it was, unmemoized,
            // so a later read retries the move.
            if let Err(e) = vault::save(&self.key, &self.path, &map) {
                log::warn!(
                    "[secrets] could not move {account:?} into the vault: {}",
                    e.message
                );

                return Ok(Some(value));
            }

            let landed = vault::load(&self.key, &self.path)
                .map(|reloaded| reloaded.get(account) == Some(&value))
                .unwrap_or(false);

            if !landed {
                log::warn!("[secrets] {account:?} did not read back from the vault; keeping the keychain item");

                return Ok(Some(value));
            }

            if let Err(e) = keychain_remove(account) {
                log::warn!(
                    "[secrets] moved {account:?} into the vault but could not drop the old item: {}",
                    e.message
                );
            }

            self.checked.insert(account.to_string());

            Ok(Some(value))
        }

        pub fn write(&mut self, account: &str, value: &str) -> Result<(), SecretsError> {
            let mut map = vault::load(&self.key, &self.path)?;

            map.insert(account.to_string(), value.to_string());

            vault::save(&self.key, &self.path, &map)
        }

        /// Forget one account everywhere it could be: the vault, the login-keychain
        /// item and the legacy store. The sweep ignores the memo, or the next read
        /// would migrate a signed-out credential straight back in.
        pub fn remove(&mut self, account: &str) -> Result<(), SecretsError> {
            let mut map = vault::load(&self.key, &self.path)?;

            if map.remove(account).is_some() {
                vault::save(&self.key, &self.path, &map)?;
            }

            keychain_remove(account)?;
            self.checked.remove(account);

            Ok(())
        }
    }

    /// The value an earlier build stored as an item, WITHOUT moving it anywhere.
    ///
    /// The per-item login-keychain entry first, then the legacy Protected Data
    /// store. A current store that refuses is an error — "could not look" must not
    /// read as "nothing stored" — while a legacy store that refuses is dropped for
    /// the run, exactly as `adopt_legacy` does.
    fn find_outside(account: &str) -> Result<Option<String>, SecretsError> {
        match entry(account)?.get_password() {
            Ok(value) => return Ok(Some(value)),
            Err(keyring_core::Error::NoEntry) => {}
            Err(e) => {
                return Err(SecretsError::store_failed(format!(
                    "the keyring refused the read: {e}"
                )))
            }
        }

        let Some(legacy) = legacy_entry(account) else {
            return Ok(None);
        };

        match legacy.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring_core::Error::NoEntry) => Ok(None),
            Err(e) => {
                log::warn!("[secrets] the previous credential store is unreadable: {e}");
                set_legacy_store(None);

                Ok(None)
            }
        }
    }

    /// How far along the vault is. "Nobody told us where it lives" is a wiring bug;
    /// "we know where but have not opened it" is a retryable outcome.
    pub enum Slot {
        #[cfg_attr(test, allow(dead_code))]
        Unconfigured,
        Pending(PathBuf),
        Open(Vault),
    }

    impl Slot {
        /// Open the vault, fetching the key the first time. A failure leaves the
        /// slot `Pending`, so a dismissed keychain dialog costs one attempt, not the
        /// whole session's credentials.
        pub fn open(
            &mut self,
            load_key: impl FnOnce() -> Result<vault::MasterKey, SecretsError>,
        ) -> Result<&mut Vault, SecretsError> {
            if let Self::Pending(dir) = self {
                let dir = dir.clone();

                *self = Self::Open(Vault::new(&dir, load_key()?));
            }

            match self {
                Self::Open(vault) => Ok(vault),
                _ => Err(SecretsError::unavailable(
                    "the credential vault was not configured at startup",
                )),
            }
        }
    }

    #[cfg(not(test))]
    static VAULT: Mutex<Slot> = Mutex::new(Slot::Unconfigured);

    /// Point the vault at a directory. Idempotent; a second call is ignored.
    #[cfg(not(test))]
    pub fn configure(dir: PathBuf) {
        let mut slot = VAULT.lock().unwrap_or_else(|p| p.into_inner());

        if matches!(*slot, Slot::Unconfigured) {
            *slot = Slot::Pending(dir);
        }
    }

    /// Run `f` against the process-wide vault.
    ///
    /// The mutex is held across the whole call, including the keychain dialog the
    /// first access may raise and load-modify-save: two threads racing the
    /// bootstrap would each mint a key and leave one vault unopenable, and two
    /// racing a write would lose a secret. Every caller reaches this through
    /// `mod.rs::blocking`, which keeps a modal dialog off the main thread.
    #[cfg(not(test))]
    pub fn with_global<T>(
        f: impl FnOnce(&mut Vault) -> Result<T, SecretsError>,
    ) -> Result<T, SecretsError> {
        let mut slot = VAULT.lock().unwrap_or_else(|p| p.into_inner());

        f(slot.open(load_or_create_master_key)?)
    }

    /// The key that seals the vault: read from the login keychain, or minted and
    /// stored on first use. Read directly — never through the legacy adoption, which
    /// has no business with it.
    ///
    /// A stored value that will not parse is an error and never a reason to mint a
    /// replacement: a new key would seal the next write under something that cannot
    /// open the existing vault, orphaning every credential in it.
    fn load_or_create_master_key() -> Result<vault::MasterKey, SecretsError> {
        let item = entry(MASTER_KEY_ACCOUNT)?;

        match item.get_password() {
            Ok(encoded) => return vault::MasterKey::from_base64(&encoded),
            Err(keyring_core::Error::NoEntry) => {}
            Err(e) => {
                return Err(SecretsError::store_failed(format!(
                    "the keyring refused the vault key: {e}"
                )))
            }
        }

        let key = vault::MasterKey::generate()?;

        item.set_password(&key.to_base64()).map_err(|e| {
            SecretsError::store_failed(format!("the keyring refused the vault key: {e}"))
        })?;

        Ok(key)
    }

    #[cfg(test)]
    pub(super) fn master_key_for_test() -> Result<vault::MasterKey, SecretsError> {
        load_or_create_master_key()
    }
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

/// The vault tier, stacked on the same mock store the keychain tests use: the
/// mock plays the keychain, a scratch directory plays the app data dir, and the
/// key is fixed — so what is tested is the migration order, not the file format.
#[cfg(test)]
mod vault_tests {
    use keyring_core::api::CredentialStoreApi;
    use keyring_core::mock;

    use super::vaulted::{Slot, Vault};
    use super::*;
    use crate::secrets::error::SecretsErrorKind;
    use crate::secrets::vault;

    fn key() -> vault::MasterKey {
        vault::MasterKey::from_bytes([3u8; vault::KEY_LEN])
    }

    /// The `TempDir` is returned because dropping it deletes the directory. Every
    /// test uses its own account name: the mock keychain is process-wide.
    fn scratch_vault() -> (tempfile::TempDir, Vault) {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::new(dir.path(), key());

        (dir, vault)
    }

    /// Store a value as a per-item keychain entry, as the current mjx build does.
    fn plant(account: &str, value: &str) {
        entry(account).unwrap().set_password(value).unwrap();
    }

    fn item(account: &str) -> Option<String> {
        match entry(account).unwrap().get_password() {
            Ok(value) => Some(value),
            Err(keyring_core::Error::NoEntry) => None,
            Err(e) => panic!("{e}"),
        }
    }

    #[test]
    fn a_write_is_served_back_without_touching_the_keychain() {
        let (_dir, mut vault) = scratch_vault();

        vault.write("vault-test-plain", "v1").unwrap();

        assert_eq!(
            vault.read("vault-test-plain").unwrap().as_deref(),
            Some("v1")
        );
        assert_eq!(item("vault-test-plain"), None);
    }

    #[test]
    fn a_missing_credential_reads_as_none_not_an_error() {
        let (_dir, mut vault) = scratch_vault();

        assert_eq!(vault.read("vault-test-absent").unwrap(), None);
    }

    /// THE upgrade path. Every existing mjx install holds its credentials as
    /// per-item keychain entries; the first read after upgrading must return the
    /// credential, leave it in the vault, and only then drop the item.
    #[test]
    fn an_existing_keychain_credential_survives_the_move_into_the_vault() {
        let (dir, mut vault) = scratch_vault();
        plant("vault-test-migrate", "stored-by-the-previous-build");

        assert_eq!(
            vault.read("vault-test-migrate").unwrap().as_deref(),
            Some("stored-by-the-previous-build")
        );
        assert_eq!(item("vault-test-migrate"), None);

        // Genuinely in the file, not merely passed through: a fresh vault over the
        // same directory, with the keychain item gone, still has it.
        let mut fresh = Vault::new(dir.path(), key());
        assert_eq!(
            fresh.read("vault-test-migrate").unwrap().as_deref(),
            Some("stored-by-the-previous-build")
        );
    }

    /// Two moves deep: a credential only the Protected Data store holds.
    #[test]
    fn a_protected_data_credential_is_moved_into_the_vault_too() {
        let _guard = crate::secrets::gate::test_guard();
        let previous = mock::Store::new().unwrap();
        previous
            .build(SERVICE, &user("vault-test-protected"), None)
            .unwrap()
            .set_password("from-protected-data")
            .unwrap();
        set_legacy_store(Some(previous.clone() as Arc<CredentialStore>));

        let (dir, mut vault) = scratch_vault();

        assert_eq!(
            vault.read("vault-test-protected").unwrap().as_deref(),
            Some("from-protected-data")
        );

        let mut fresh = Vault::new(dir.path(), key());
        assert_eq!(
            fresh.read("vault-test-protected").unwrap().as_deref(),
            Some("from-protected-data")
        );
        assert!(matches!(
            previous
                .build(SERVICE, &user("vault-test-protected"), None)
                .unwrap()
                .get_password(),
            Err(keyring_core::Error::NoEntry)
        ));

        set_legacy_store(None);
    }

    #[test]
    fn the_vault_wins_over_a_stale_keychain_item() {
        let (_dir, mut vault) = scratch_vault();
        plant("vault-test-stale", "stale");
        vault.write("vault-test-stale", "current").unwrap();

        assert_eq!(
            vault.read("vault-test-stale").unwrap().as_deref(),
            Some("current")
        );
        assert_eq!(item("vault-test-stale").as_deref(), Some("stale"));
    }

    #[test]
    fn the_keychain_is_searched_once_per_account() {
        let (_dir, mut vault) = scratch_vault();

        assert_eq!(vault.read("vault-test-memo").unwrap(), None);

        plant("vault-test-memo", "planted-after-the-miss");

        assert_eq!(vault.read("vault-test-memo").unwrap(), None);
    }

    #[test]
    fn removing_sweeps_the_vault_and_the_keychain() {
        let (_dir, mut vault) = scratch_vault();
        plant("vault-test-wipe", "item");
        vault.write("vault-test-wipe", "current").unwrap();

        vault.remove("vault-test-wipe").unwrap();

        assert_eq!(vault.read("vault-test-wipe").unwrap(), None);
        assert_eq!(item("vault-test-wipe"), None);
    }

    #[test]
    fn a_memoized_miss_does_not_survive_a_sign_out() {
        let (_dir, mut vault) = scratch_vault();

        assert_eq!(vault.read("vault-test-memo-wipe").unwrap(), None);
        vault.remove("vault-test-memo-wipe").unwrap();
        plant("vault-test-memo-wipe", "planted");

        assert_eq!(
            vault.read("vault-test-memo-wipe").unwrap().as_deref(),
            Some("planted")
        );
    }

    /// A directory the process cannot write. `None` where it can write anyway
    /// (root), because there the premise does not hold.
    #[cfg(unix)]
    fn read_only_dir() -> Option<tempfile::TempDir> {
        use std::os::unix::fs::PermissionsExt as _;

        let dir = tempfile::tempdir().unwrap();
        let mut perms = std::fs::metadata(dir.path()).unwrap().permissions();
        perms.set_mode(0o500);
        std::fs::set_permissions(dir.path(), perms).unwrap();

        if std::fs::write(dir.path().join("probe"), b"x").is_ok() {
            return None;
        }

        Some(dir)
    }

    /// The credential-loss guard: a move that cannot be saved returns the value and
    /// never deletes the only copy.
    #[cfg(unix)]
    #[test]
    fn a_move_that_cannot_be_saved_keeps_the_keychain_item() {
        let Some(dir) = read_only_dir() else {
            return;
        };

        let mut vault = Vault::new(dir.path(), key());
        plant("vault-test-unsaveable", "only-copy");

        assert_eq!(
            vault.read("vault-test-unsaveable").unwrap().as_deref(),
            Some("only-copy")
        );
        assert_eq!(item("vault-test-unsaveable").as_deref(), Some("only-copy"));
        // Not memoized, so a later launch with a writable directory retries.
        assert_eq!(
            vault.read("vault-test-unsaveable").unwrap().as_deref(),
            Some("only-copy")
        );
    }

    #[test]
    fn a_vault_that_cannot_be_read_is_an_error_rather_than_an_empty_one() {
        let dir = tempfile::tempdir().unwrap();
        let wedged = dir.path().join("wedged");
        std::fs::write(&wedged, b"not a directory").unwrap();

        let mut vault = Vault::new(&wedged, key());

        assert!(vault.read("vault-test-unreadable").is_err());
    }

    #[test]
    fn an_unconfigured_slot_refuses_rather_than_answering_from_nowhere() {
        let refused = match Slot::Unconfigured.open(|| Ok(key())) {
            Err(refused) => refused,
            Ok(_) => panic!("an unconfigured vault must not answer"),
        };

        assert_eq!(refused.kind, SecretsErrorKind::Unavailable);
    }

    #[test]
    fn a_failed_key_fetch_leaves_the_slot_retryable() {
        let dir = tempfile::tempdir().unwrap();
        let mut slot = Slot::Pending(dir.path().to_path_buf());

        assert!(slot
            .open(|| Err(SecretsError::locked("dismissed")))
            .is_err());
        assert!(slot.open(|| Ok(key())).is_ok());
    }

    #[test]
    fn the_master_key_is_minted_once_and_read_back_after() {
        let first = super::vaulted::master_key_for_test().unwrap();
        let second = super::vaulted::master_key_for_test().unwrap();

        assert_eq!(&*first.to_base64(), &*second.to_base64());
        assert_eq!(first.to_base64().len(), 44);
    }
}
