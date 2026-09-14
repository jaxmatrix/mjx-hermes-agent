//! The multi-connection registry (MJXHRM-446) — state, persistence, commands.
//!
//! Rust owns the registry because Rust owns everything it depends on: the
//! network (rule 2), the credentials (rule 4) and a durable place to put a
//! document that must survive a webview data reset (`app_state.rs`'s reasoning,
//! one layer up). The webview owns which connection is ACTIVE, and nothing here
//! knows or cares which one that is — rule 3 survives, because what Rust holds
//! is a table of base URL → credential, not an active-gateway object.
//!
//! The document itself is guarded by a `std::sync::Mutex` with no `await` held
//! across it. Tauri commands are NOT serialised by default, so this lock is what
//! replaces the accidental ordering Electron got for free from `ipcMain.handle`;
//! two saves racing would otherwise interleave read → mutate → write and lose
//! one of them.

pub mod error;
pub mod probe;
pub mod registry;
pub mod roster;
pub mod secrets;

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

pub use error::{ConnectionsError, ConnectionsErrorKind};
pub use registry::{backend_scope_key, registry_backend_scope_key};

use probe::{ProbeResult, ProbeVerdict, WsAuthPlan};
use registry::{
    dial_connection_id, is_legacy_connection, merge_connection_input, migrate_from_v1_target,
    normalize_connection_input, normalize_registry, AuthMode, Connection, ConnectionInput,
    ConnectionKind, LaunchMode, Registry, MAX_DOCUMENT_BYTES, REGISTRY_VERSION,
};
use roster::RosterCache;
use secrets::{ConnectionScope, ConnectionSecret};

const FILE_NAME: &str = "connections.json";
const BACKUP_NAME: &str = "connections.json.bak";

/// Emitted after any successful mutation. `app.emit` rather than a per-window
/// emit because EVERY window's registry view has to refresh — a rename made in a
/// settings Activity has to reach the shell that is painting the source chip.
const CHANGED_EVENT: &str = "hermes://connections-changed";

#[derive(Default)]
pub struct ConnectionsState {
    /// The document. `None` until first read; `Some` afterwards, including the
    /// in-memory-only registry a platform with no data dir gets.
    document: std::sync::Mutex<Option<Registry>>,
    /// Why the last load had to repair something, if it did. Rule 9: a degrade
    /// is reported, never silent.
    degraded: std::sync::Mutex<Option<String>>,
    /// True when the document on disk was written by a NEWER build. Read-only:
    /// a downgrade must not be able to destroy a newer install's sources.
    read_only: std::sync::Mutex<bool>,
    roster: Arc<RosterCache>,
}

// --------------------------------------------------------------------------
// The view the webview sees — non-secret by construction
// --------------------------------------------------------------------------

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionView {
    pub id: String,
    pub kind: ConnectionKind,
    pub label: String,
    pub order: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth_mode: Option<AuthMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub org: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_hermes_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_profile: Option<String>,
    /// Whether a token is stored. NEVER the bytes.
    pub has_token: bool,
    /// The last four characters, for "is this the one I pasted?".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_preview: Option<String>,
    pub header_names: Vec<String>,
    pub has_ssh_key: bool,
    pub has_ssh_passphrase: bool,
    pub has_ssh_password: bool,
    /// Whether this row owns the pre-registry keyring accounts and pool scope.
    pub legacy: bool,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RegistryView {
    pub version: u32,
    pub primary: String,
    pub launch_mode: LaunchMode,
    pub last_used: String,
    pub connections: Vec<ConnectionView>,
    /// Present when the document was unusable and was rebuilt.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub degraded: Option<String>,
    /// Whether this platform can host a `local` entry at all.
    pub local_supported: bool,
    /// Whether the document may be mutated (false for a future version).
    pub read_only: bool,
    /// Whether this device has a credential store. A token-mode save is refused
    /// without one, and the editor needs to say so BEFORE the user types.
    pub keyring_available: bool,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SaveOutcome {
    pub registry: RegistryView,
    pub connection_id: String,
    /// Whether every pooled backend and live socket for this connection has to
    /// be recycled. A label-only edit is false, and keeping traffic flowing
    /// through a rename is the whole reason this is reported rather than assumed.
    pub dial_fields_changed: bool,
    /// Header names that were refused by the allowlist, so the editor can say
    /// which — a silently dropped header is an unexplained failure later.
    pub dropped_headers: Vec<String>,
}

/// What a dial needs, with no credential in it.
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedDial {
    pub connection_id: String,
    /// `backend_scope_key(dial_connection_id(...), profile)` — BARE for the
    /// legacy owner, which is what keeps `ssh_ownership_id` unchanged.
    pub scope_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    pub mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth_mode: Option<AuthMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_host: Option<String>,
    pub label: String,
    pub kind: ConnectionKind,
    /// TRUE when Rust holds a token for this base — so the frontend can render
    /// "token auth" without ever seeing one. Rule 9: report the state, not the
    /// value.
    pub token_attached: bool,
    pub header_names: Vec<String>,
    /// The id a DIAL should carry (absent for the legacy owner). The frontend
    /// passes it straight back into `ssh_connect` / `ws_open`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dial_connection_id: Option<String>,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UpdateTargetResult {
    pub connection_id: String,
    pub label: String,
    pub ok: bool,
    pub skipped: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

// --------------------------------------------------------------------------
// Persistence
// --------------------------------------------------------------------------

fn registry_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join(FILE_NAME))
}

/// Whether this device can host a `local` (spawned) backend.
///
/// Mirrors `LOCAL_MODE_SUPPORTED` in `lib/platform.ts`. The registry consequence
/// is that "exactly one local, never removable" becomes "AT MOST one, present
/// only where it can be dialled" — a phone showing a `local` row would be
/// showing a row that cannot work.
fn local_supported() -> bool {
    cfg!(desktop)
}

/// Read the document. A corrupt or oversize file is kept as one `.bak`
/// generation and the registry is rebuilt — reported, never silent.
fn read_document(path: &Path) -> (Option<Registry>, Option<String>, bool) {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return (None, None, false);
    };

    if raw.len() > MAX_DOCUMENT_BYTES {
        let _ = std::fs::rename(path, path.with_file_name(BACKUP_NAME));

        return (None, Some("oversize".to_string()), false);
    }

    match serde_json::from_str::<Registry>(&raw) {
        Ok(parsed) if parsed.version > REGISTRY_VERSION => {
            // NOT rewritten. A newer build's sources survive a downgrade.
            (Some(parsed), Some("future-version".to_string()), true)
        }
        Ok(parsed) => (Some(parsed), None, false),
        Err(_) => {
            let _ = std::fs::rename(path, path.with_file_name(BACKUP_NAME));

            (None, Some("corrupt".to_string()), false)
        }
    }
}

fn write_document(path: &Path, registry: &Registry) -> Result<(), ConnectionsError> {
    let body = serde_json::to_string_pretty(registry)
        .map_err(|e| ConnectionsError::write_failed(e.to_string()))?;

    if body.len() > MAX_DOCUMENT_BYTES {
        return Err(ConnectionsError::new(
            ConnectionsErrorKind::RegistryFull,
            "the gateway list is too large to save",
        ));
    }

    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| ConnectionsError::write_failed(e.to_string()))?;
    }

    std::fs::write(path, body).map_err(|e| ConnectionsError::write_failed(e.to_string()))
}

impl ConnectionsState {
    /// The document, loading it once. Never fails: a platform with no data dir
    /// gets an in-memory registry for this run and a `degraded` reason, because
    /// silently degrading to "you have one gateway" is the one outcome that
    /// reads as data loss.
    fn load(&self, app: &AppHandle) -> Registry {
        if let Some(held) = self.document.lock().ok().and_then(|held| held.clone()) {
            return held;
        }

        let (parsed, mut degraded, read_only) = match registry_path(app) {
            Some(path) => read_document(&path),
            None => (None, Some("no-data-dir".to_string()), false),
        };

        let mut registry = parsed.unwrap_or_default();

        if let Some(repair) = normalize_registry(&mut registry, local_supported()) {
            degraded.get_or_insert(repair);
        }

        if let Ok(mut slot) = self.document.lock() {
            *slot = Some(registry.clone());
        }

        if let Ok(mut slot) = self.degraded.lock() {
            *slot = degraded;
        }

        if let Ok(mut slot) = self.read_only.lock() {
            *slot = read_only;
        }

        registry
    }

    fn degraded(&self) -> Option<String> {
        self.degraded.lock().ok().and_then(|held| held.clone())
    }

    fn read_only(&self) -> bool {
        self.read_only.lock().map(|held| *held).unwrap_or(false)
    }

    /// Read → mutate → write the WHOLE file, under the lock. The
    /// sibling-preserving pattern of `app_state.rs:64`, one document up: two
    /// mutations in either order both survive.
    fn mutate<T>(
        &self,
        app: &AppHandle,
        change: impl FnOnce(&mut Registry) -> Result<T, ConnectionsError>,
    ) -> Result<T, ConnectionsError> {
        if self.read_only() {
            return Err(ConnectionsError::new(
                ConnectionsErrorKind::FutureVersion,
                "this gateway list was written by a newer version of Hermes",
            ));
        }

        let mut registry = self.load(app);
        let outcome = change(&mut registry)?;

        normalize_registry(&mut registry, local_supported());

        if let Some(path) = registry_path(app) {
            write_document(&path, &registry)?;
        } else if self.degraded().is_none() {
            return Err(ConnectionsError::new(
                ConnectionsErrorKind::NoDataDir,
                "this device has nowhere to save the gateway list, so the change lasts only until Hermes closes",
            ));
        }

        if let Ok(mut slot) = self.document.lock() {
            *slot = Some(registry);
        }

        Ok(outcome)
    }
}

// --------------------------------------------------------------------------
// Views + credential plumbing
// --------------------------------------------------------------------------

fn scope_for(registry: &Registry, connection: &Connection) -> ConnectionScope {
    ConnectionScope::new(
        connection.id.clone(),
        is_legacy_connection(registry, &connection.id),
    )
}

fn to_view(registry: &Registry, connection: &Connection) -> ConnectionView {
    let scope = scope_for(registry, connection);
    let token = secrets::read(&scope, ConnectionSecret::Token)
        .ok()
        .flatten();

    ConnectionView {
        auth_mode: connection.auth_mode,
        has_ssh_key: secrets::read(&scope, ConnectionSecret::SshKey)
            .ok()
            .flatten()
            .is_some(),
        has_ssh_passphrase: secrets::read(&scope, ConnectionSecret::SshPassphrase)
            .ok()
            .flatten()
            .is_some(),
        has_ssh_password: secrets::read(&scope, ConnectionSecret::SshPassword)
            .ok()
            .flatten()
            .is_some(),
        has_token: token.is_some(),
        header_names: connection.header_names.clone(),
        host: connection.host.clone(),
        id: connection.id.clone(),
        key_path: connection.key_path.clone(),
        kind: connection.kind,
        label: connection.label.clone(),
        legacy: scope.legacy,
        order: connection.order,
        org: connection.org.clone(),
        port: connection.port,
        remote_hermes_path: connection.remote_hermes_path.clone(),
        remote_profile: connection.remote_profile.clone(),
        // The VALUE never leaves Rust; four characters is enough to recognise a
        // paste and not enough to reconstruct anything.
        token_preview: token.as_deref().and_then(secrets::token_preview),
        url: connection.url.clone(),
        user: connection.user.clone(),
    }
}

fn to_registry_view(state: &ConnectionsState, registry: &Registry) -> RegistryView {
    RegistryView {
        connections: registry
            .connections
            .iter()
            .map(|row| to_view(registry, row))
            .collect(),
        degraded: state.degraded(),
        keyring_available: crate::secrets::store::ensure().is_ok(),
        last_used: registry.last_used.clone(),
        launch_mode: registry.launch_mode,
        local_supported: local_supported(),
        primary: registry.primary.clone(),
        read_only: state.read_only(),
        version: registry.version,
    }
}

/// Publish one connection's credentials into the transport's attach table, so
/// every REST call and WS upgrade under its base carries them.
fn publish_auth(app: &AppHandle, registry: &Registry, connection: &Connection) {
    let Some(base) = connection.url.as_deref() else {
        return;
    };

    let scope = scope_for(registry, connection);
    let token = secrets::read(&scope, ConnectionSecret::Token)
        .ok()
        .flatten();
    let headers = connection
        .header_names
        .iter()
        .filter_map(|name| {
            secrets::read_header(&connection.id, name)
                .ok()
                .flatten()
                .map(|value| (name.clone(), value))
        })
        .collect();

    app.state::<crate::transport::TransportState>()
        .set_connection_auth(
            base,
            crate::transport::ConnectionAuth {
                connection_id: connection.id.clone(),
                headers,
                token,
            },
        );
}

fn find<'a>(registry: &'a Registry, id: &str) -> Result<&'a Connection, ConnectionsError> {
    registry
        .connections
        .iter()
        .find(|row| row.id == id)
        .ok_or_else(|| ConnectionsError::not_found(id))
}

fn notify_changed(app: &AppHandle, reason: &str, connection_id: Option<&str>) {
    let _ = app.emit(
        CHANGED_EVENT,
        serde_json::json!({ "reason": reason, "connectionId": connection_id }),
    );
}

/// One registered connection's SSH material, read in Rust.
///
/// This is why `SshConnectConfig`'s secret fields became optional: for
/// connections 2..N the credentials live under `OwnedKey` accounts the webview
/// CANNOT name, so the only way to dial them is for Rust to read them itself —
/// which is also rule 4's preferred shape, since a PEM stops crossing IPC.
///
/// The legacy owner deliberately does not come through here: it keeps passing
/// the arguments it always passed, so its dial is byte-identical.
#[derive(Debug, Clone, Default)]
pub struct SshCredentials {
    pub private_key_pem: Option<String>,
    pub passphrase: Option<String>,
    pub password: Option<String>,
    pub reuse_token: Option<String>,
}

pub fn ssh_credentials(app: &AppHandle, connection_id: &str) -> Option<SshCredentials> {
    let state = app.try_state::<ConnectionsState>()?;
    let registry = state.load(app);
    let connection = registry
        .connections
        .iter()
        .find(|row| row.id == connection_id)?;
    let scope = scope_for(&registry, connection);

    let read = |secret: ConnectionSecret| secrets::read(&scope, secret).ok().flatten();

    Some(SshCredentials {
        passphrase: read(ConnectionSecret::SshPassphrase),
        password: read(ConnectionSecret::SshPassword),
        private_key_pem: read(ConnectionSecret::SshKey),
        reuse_token: read(ConnectionSecret::ReuseToken),
    })
}

/// Remember the token a just-connected registered backend was started with, so
/// the NEXT dial reattaches instead of respawning.
pub fn remember_reuse_token(app: &AppHandle, connection_id: &str, token: &str) {
    let Some(state) = app.try_state::<ConnectionsState>() else {
        return;
    };
    let registry = state.load(app);
    let Some(connection) = registry
        .connections
        .iter()
        .find(|row| row.id == connection_id)
    else {
        return;
    };

    let _ = secrets::write(
        &scope_for(&registry, connection),
        ConnectionSecret::ReuseToken,
        token,
    );
}

// --------------------------------------------------------------------------
// Commands
// --------------------------------------------------------------------------

#[tauri::command]
pub async fn connections_list(
    app: AppHandle,
    state: State<'_, ConnectionsState>,
) -> Result<RegistryView, ConnectionsError> {
    let registry = state.load(&app);

    for connection in &registry.connections {
        publish_auth(&app, &registry, connection);
    }

    Ok(to_registry_view(&state, &registry))
}

/// Seed the registry from the pre-registry `hermes.connection.last`.
///
/// Rust cannot read `localStorage`, so the WEBVIEW hands over the one non-secret
/// value it already holds — the same shape as every other push-down. Idempotent:
/// a no-op once a document exists, so a second window at boot cannot re-migrate.
#[tauri::command]
pub async fn connections_migrate(
    app: AppHandle,
    state: State<'_, ConnectionsState>,
    legacy_target: Option<serde_json::Value>,
) -> Result<RegistryView, ConnectionsError> {
    let existing = registry_path(&app).is_some_and(|path| path.exists());

    if existing || state.read_only() {
        return connections_list(app, state).await;
    }

    let migrated = migrate_from_v1_target(legacy_target.as_ref(), local_supported());

    if let Ok(mut slot) = state.document.lock() {
        *slot = Some(migrated.clone());
    }

    if let Some(path) = registry_path(&app) {
        write_document(&path, &migrated)?;
    }

    for connection in &migrated.connections {
        publish_auth(&app, &migrated, connection);
    }

    Ok(to_registry_view(&state, &migrated))
}

#[tauri::command]
pub async fn connections_save(
    app: AppHandle,
    state: State<'_, ConnectionsState>,
    input: ConnectionInput,
) -> Result<SaveOutcome, ConnectionsError> {
    let holds_credential = input
        .token
        .as_deref()
        .or(input.private_key_pem.as_deref())
        .or(input.passphrase.as_deref())
        .or(input.password.as_deref())
        .is_some_and(|value| !value.is_empty())
        || input
            .headers
            .as_ref()
            .is_some_and(|headers| headers.values().any(|value| !value.is_empty()));

    // Refused BEFORE anything is written, and never with a plaintext fallback:
    // universal has no plaintext credential store and must not grow one.
    if holds_credential && crate::secrets::store::ensure().is_err() {
        return Err(ConnectionsError::new(
            ConnectionsErrorKind::KeyringUnavailable,
            "this device has no credential store, so a gateway secret cannot be saved",
        ));
    }

    let (connection, changed, dropped) = state.mutate(&app, |registry| {
        let existing = input
            .id
            .as_deref()
            .map(|id| find(registry, id).cloned())
            .transpose()?;

        let taken_ids: BTreeSet<String> = registry
            .connections
            .iter()
            .map(|row| row.id.clone())
            .collect();
        let taken_labels: BTreeSet<String> = registry
            .connections
            .iter()
            .filter(|row| Some(row.id.as_str()) != input.id.as_deref())
            .map(|row| registry::label_key(&row.label))
            .collect();

        if !local_supported() && input.kind == ConnectionKind::Local {
            return Err(ConnectionsError::new(
                ConnectionsErrorKind::LocalUnsupported,
                "this device can't run a Hermes backend — connect to one over SSH or a URL",
            ));
        }

        let order = registry.connections.len() as u32;
        let (connection, dropped) = normalize_connection_input(
            &input,
            existing.as_ref(),
            order,
            &taken_ids,
            &taken_labels,
        )?;

        let changed = merge_connection_input(registry, connection.clone())?;

        Ok((connection, changed, dropped))
    })?;

    // The keyring writes happen AFTER the document is committed, so a rejected
    // save never leaves a credential behind under an id the registry does not
    // have. Serialised behind the same lock by construction: `mutate` returned.
    let registry = state.load(&app);
    let scope = scope_for(&registry, &connection);

    let write = |secret: ConnectionSecret, value: Option<&String>| {
        if let Some(value) = value {
            let _ = secrets::write(&scope, secret, value);
        }
    };

    write(ConnectionSecret::Token, input.token.as_ref());
    write(ConnectionSecret::SshKey, input.private_key_pem.as_ref());
    write(ConnectionSecret::SshPassphrase, input.passphrase.as_ref());
    write(ConnectionSecret::SshPassword, input.password.as_ref());

    if let Some(headers) = &input.headers {
        for (name, value) in headers {
            let lower = name.trim().to_ascii_lowercase();

            if connection.header_names.contains(&lower) {
                let _ = secrets::write_header(&connection.id, &lower, value);
            }
        }
    }

    publish_auth(&app, &registry, &connection);
    notify_changed(&app, "saved", Some(&connection.id));

    Ok(SaveOutcome {
        connection_id: connection.id.clone(),
        dial_fields_changed: changed,
        dropped_headers: dropped,
        registry: to_registry_view(&state, &registry),
    })
}

#[tauri::command]
pub async fn connections_remove(
    app: AppHandle,
    state: State<'_, ConnectionsState>,
    connection_id: String,
) -> Result<RegistryView, ConnectionsError> {
    let removed = state.mutate(&app, |registry| {
        let connection = find(registry, &connection_id)?.clone();

        if connection.kind == ConnectionKind::Local && local_supported() {
            return Err(ConnectionsError::new(
                ConnectionsErrorKind::LocalNotRemovable,
                "this device's own backend can't be removed",
            ));
        }

        let scope = scope_for(registry, &connection);

        registry.connections.retain(|row| row.id != connection_id);

        Ok((connection, scope))
    })?;

    let (connection, scope) = removed;
    let registry = state.load(&app);

    let _ = secrets::sweep(&connection, &scope);

    // The OAuth token set is keyed by BASE URL, not by connection, so it is only
    // swept when no surviving entry shares that base — otherwise removing one of
    // two sources pointing at one gateway would sign the other one out.
    if let Some(base) = &connection.url {
        let still_used = registry
            .connections
            .iter()
            .any(|row| row.url.as_deref() == Some(base.as_str()));

        if !still_used {
            let _ = crate::secrets::remove_owned(crate::secrets::OwnedKey::NativeAuth, base);
            app.state::<crate::transport::TransportState>()
                .forget_bearer_base(base);
        }
    }

    app.state::<crate::transport::TransportState>()
        .forget_connection_auth(&connection.id);
    notify_changed(&app, "removed", Some(&connection.id));

    Ok(to_registry_view(&state, &registry))
}

#[tauri::command]
pub async fn connections_set_primary(
    app: AppHandle,
    state: State<'_, ConnectionsState>,
    connection_id: String,
) -> Result<RegistryView, ConnectionsError> {
    state.mutate(&app, |registry| {
        find(registry, &connection_id)?;
        registry.primary = connection_id.clone();

        Ok(())
    })?;

    notify_changed(&app, "primary", Some(&connection_id));

    Ok(to_registry_view(&state, &state.load(&app)))
}

#[tauri::command]
pub async fn connections_set_launch_mode(
    app: AppHandle,
    state: State<'_, ConnectionsState>,
    launch_mode: LaunchMode,
) -> Result<RegistryView, ConnectionsError> {
    state.mutate(&app, |registry| {
        registry.launch_mode = launch_mode;

        Ok(())
    })?;

    notify_changed(&app, "launch-mode", None);

    Ok(to_registry_view(&state, &state.load(&app)))
}

/// Remember the switch that just succeeded.
///
/// Its failure is deliberately swallowed at the CALL SITE: a full disk must not
/// turn a successful switch into a failed one (desktop's read-only-userData
/// lesson), so this returns the error and the frontend drops it.
#[tauri::command]
pub async fn connections_set_last_used(
    app: AppHandle,
    state: State<'_, ConnectionsState>,
    connection_id: String,
) -> Result<RegistryView, ConnectionsError> {
    state.mutate(&app, |registry| {
        find(registry, &connection_id)?;
        registry.last_used = connection_id.clone();

        Ok(())
    })?;

    Ok(to_registry_view(&state, &state.load(&app)))
}

/// What a dial needs. NEVER carries a token — `token_attached` reports that one
/// exists, which is what the UI actually has to render.
#[tauri::command]
pub async fn connections_resolve(
    app: AppHandle,
    state: State<'_, ConnectionsState>,
    connection_id: String,
    profile: Option<String>,
) -> Result<ResolvedDial, ConnectionsError> {
    let registry = state.load(&app);
    let connection = find(&registry, &connection_id)?.clone();
    let scope = scope_for(&registry, &connection);
    let dial_id = dial_connection_id(&registry, &connection.id).map(str::to_string);

    publish_auth(&app, &registry, &connection);

    let profile = profile
        .or_else(|| connection.remote_profile.clone())
        .filter(|value| !value.trim().is_empty());

    Ok(ResolvedDial {
        auth_mode: connection.auth_mode,
        base_url: connection.url.clone(),
        connection_id: connection.id.clone(),
        header_names: connection.header_names.clone(),
        kind: connection.kind,
        label: connection.label.clone(),
        mode: connection.kind.mode().to_string(),
        profile: profile.clone(),
        remote_host: match connection.kind {
            ConnectionKind::Ssh => Some(match (&connection.user, &connection.host) {
                (Some(user), Some(host)) => format!("{user}@{host}"),
                (None, Some(host)) => host.clone(),
                _ => connection.label.clone(),
            }),
            _ => None,
        },
        scope_key: backend_scope_key(dial_id.as_deref(), profile.as_deref()),
        token_attached: secrets::read(&scope, ConnectionSecret::Token)
            .ok()
            .flatten()
            .is_some(),
        dial_connection_id: dial_id,
    })
}

#[tauri::command]
pub async fn connections_test(
    app: AppHandle,
    state: State<'_, ConnectionsState>,
    connection_id: String,
) -> Result<ProbeResult, ConnectionsError> {
    let registry = state.load(&app);
    let connection = find(&registry, &connection_id)?.clone();
    let scope = scope_for(&registry, &connection);
    let base_url = probe::probe_base_url(&connection)?;

    publish_auth(&app, &registry, &connection);

    let (http, status) = probe::probe_http_leg(&app, &base_url).await;

    let auth_flows = status
        .get("auth_flows")
        .and_then(serde_json::Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|value| value.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let auth_required = status
        .get("auth_required")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);

    // Leg 1 refusing is the whole answer: leg 2 would only repeat it.
    if !http.ok {
        let verdict = probe::classify_probe(&http, None);

        return Ok(ProbeResult {
            auth_flows,
            auth_required,
            http,
            install_id: None,
            needs_oauth_login: verdict == ProbeVerdict::AuthRequired,
            ok: probe::verdict_is_ok(verdict),
            verdict,
            version: status
                .get("version")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string),
            ws: probe::LegResult::default(),
        });
    }

    let token = secrets::read(&scope, ConnectionSecret::Token)
        .ok()
        .flatten();
    let headers: Vec<(String, String)> = connection
        .header_names
        .iter()
        .filter_map(|name| {
            secrets::read_header(&connection.id, name)
                .ok()
                .flatten()
                .map(|value| (name.clone(), value))
        })
        .collect();

    let plan = probe::ws_auth_plan(connection.auth_mode.unwrap_or_default(), token.is_some());

    let (ws, observation) = match plan {
        WsAuthPlan::SkipNoToken => (
            probe::LegResult::default(),
            probe::WsObservation {
                skipped_no_token: true,
                ..probe::WsObservation::default()
            },
        ),
        WsAuthPlan::Token => {
            let url = probe::ws_url_for(&base_url, Some(("token", token.as_deref().unwrap_or(""))));

            probe::probe_ws_leg(&app, &url, headers).await
        }
        WsAuthPlan::Open => {
            let url = probe::ws_url_for(&base_url, None);

            probe::probe_ws_leg(&app, &url, headers).await
        }
        WsAuthPlan::Ticket => match mint_ws_ticket(&app, &base_url).await {
            Ok(ticket) => {
                let url = probe::ws_url_for(&base_url, Some(("ticket", &ticket)));

                probe::probe_ws_leg(&app, &url, headers).await
            }
            // A mint failure is a FAILURE, not a skip: a skip reads as "nothing
            // to check here", which is the opposite of "your session expired".
            Err(status) => (
                probe::LegResult {
                    error: Some("the gateway would not issue a ticket".to_string()),
                    ok: false,
                    ..probe::LegResult::default()
                },
                probe::WsObservation {
                    mint_failed: true,
                    mint_unauthorized: matches!(status, 401 | 403),
                    ..probe::WsObservation::default()
                },
            ),
        },
    };

    let verdict = probe::classify_probe(&http, Some(&observation));

    Ok(ProbeResult {
        auth_flows,
        auth_required,
        http,
        install_id: status
            .get("install_id")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
        needs_oauth_login: verdict == ProbeVerdict::AuthRequired,
        ok: probe::verdict_is_ok(verdict),
        verdict,
        version: status
            .get("version")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
        ws,
    })
}

#[tauri::command]
pub async fn connections_roster(
    app: AppHandle,
    state: State<'_, ConnectionsState>,
    force: bool,
    active_connection_id: Option<String>,
) -> Result<registry::AgentRoster, ConnectionsError> {
    let registry = state.load(&app);
    let cache = Arc::clone(&state.roster);

    Ok(roster::collect_roster(
        &app,
        &registry,
        cache,
        active_connection_id.as_deref(),
        force,
    )
    .await)
}

/// Update every eligible source that is NOT excluded, concurrently.
///
/// Rust rather than a TS loop because each row needs that source's credential
/// and Rust already holds them; the ORDER (active first, client last) is policy
/// and stays in `store/connection-updates.ts`.
#[tauri::command]
pub async fn connections_update_all(
    app: AppHandle,
    state: State<'_, ConnectionsState>,
    exclude_ids: Vec<String>,
) -> Result<Vec<UpdateTargetResult>, ConnectionsError> {
    let registry = state.load(&app);
    let mut tasks = Vec::new();

    for connection in registry.connections.clone() {
        if exclude_ids.contains(&connection.id) {
            continue;
        }

        let eligibility = registry::update_eligibility(connection.kind);

        if !eligibility.eligible {
            tasks.push(tokio::spawn(async move {
                UpdateTargetResult {
                    connection_id: connection.id,
                    detail: None,
                    label: connection.label,
                    ok: false,
                    reason: eligibility.reason,
                    skipped: true,
                }
            }));

            continue;
        }

        let Some(base_url) = connection.url.clone() else {
            // `local` and `ssh` have no addressable URL from a descriptor alone;
            // the ACTIVE one is updated by the frontend's first step.
            tasks.push(tokio::spawn(async move {
                UpdateTargetResult {
                    connection_id: connection.id,
                    detail: None,
                    label: connection.label,
                    ok: false,
                    reason: Some("connect-on-demand".to_string()),
                    skipped: true,
                }
            }));

            continue;
        };

        publish_auth(&app, &registry, &connection);

        let app = app.clone();

        tasks.push(tokio::spawn(async move {
            update_one(&app, &base_url, &connection.id, &connection.label).await
        }));
    }

    let mut results = Vec::with_capacity(tasks.len());

    for task in tasks {
        if let Ok(row) = task.await {
            results.push(row);
        }
    }

    Ok(results)
}

/// Mint a single-use ws ticket for leg 2, in Rust.
///
/// `Err(status)` carries the HTTP status because 401/403 means "sign in", which
/// is a different offer from "the gateway is unwell" — see `classify_probe`.
async fn mint_ws_ticket(app: &AppHandle, base_url: &str) -> Result<String, u16> {
    let url = format!("{}/api/auth/ws-ticket", base_url.trim_end_matches('/'));

    match crate::transport::probe_post_json(app, &url, std::time::Duration::from_secs(10)).await {
        Ok((status, body)) if (200..300).contains(&status) => body
            .get("ticket")
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .ok_or(status),
        Ok((status, _)) => Err(status),
        Err(_) => Err(0),
    }
}

async fn update_one(
    app: &AppHandle,
    base_url: &str,
    connection_id: &str,
    label: &str,
) -> UpdateTargetResult {
    let url = format!("{}/api/hermes/update", base_url.trim_end_matches('/'));

    match crate::transport::probe_post_json(app, &url, std::time::Duration::from_secs(15)).await {
        Ok((status, body)) => {
            // A backend that is docker/nix/externally managed answers 200 with
            // `ok:false` and its own reason. That row is SKIPPED with its own
            // message; the batch never fails because one target is managed.
            let ok = (200..300).contains(&status)
                && body
                    .get("ok")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(true);

            UpdateTargetResult {
                connection_id: connection_id.to_string(),
                detail: body
                    .get("message")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string),
                label: label.to_string(),
                ok,
                reason: if ok {
                    None
                } else {
                    body.get("error")
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_string)
                        .or_else(|| Some(format!("HTTP {status}")))
                },
                skipped: !ok,
            }
        }
        Err(error) => UpdateTargetResult {
            connection_id: connection_id.to_string(),
            detail: Some(error),
            label: label.to_string(),
            ok: false,
            reason: Some("unreachable".to_string()),
            skipped: false,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hermes-connections-{name}"));

        let _ = std::fs::remove_dir_all(&dir);

        dir.join(FILE_NAME)
    }

    #[test]
    fn a_missing_file_reads_as_nothing_yet() {
        let (parsed, degraded, read_only) = read_document(&scratch("missing"));

        assert!(parsed.is_none());
        assert_eq!(degraded, None);
        assert!(!read_only);
    }

    #[test]
    fn a_document_round_trips_and_survives_two_writes_in_either_order() {
        let path = scratch("round-trip");
        let mut first = Registry::default();

        first.connections.push(registry::local_connection());
        write_document(&path, &first).expect("write");

        let (parsed, degraded, _) = read_document(&path);
        assert_eq!(parsed.as_ref().map(|r| r.connections.len()), Some(1));
        assert_eq!(degraded, None);

        let mut second = parsed.expect("parsed");
        second.launch_mode = LaunchMode::Primary;
        write_document(&path, &second).expect("second write");

        let (reread, _, _) = read_document(&path);
        let reread = reread.expect("reread");
        assert_eq!(reread.launch_mode, LaunchMode::Primary);
        assert_eq!(reread.connections.len(), 1);
    }

    #[test]
    fn a_corrupt_document_is_backed_up_rebuilt_and_still_writable() {
        let path = scratch("corrupt");

        std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        std::fs::write(&path, "{not json at all").expect("seed");

        let (parsed, degraded, read_only) = read_document(&path);

        assert!(parsed.is_none());
        assert_eq!(degraded.as_deref(), Some("corrupt"));
        assert!(!read_only);
        assert!(
            path.with_file_name(BACKUP_NAME).exists(),
            "kept one .bak generation"
        );

        // A corrupt file must not wedge the registry permanently.
        write_document(&path, &Registry::default()).expect("write over corrupt");
        assert!(read_document(&path).0.is_some());
    }

    #[test]
    fn a_future_version_is_read_only_and_is_not_rewritten() {
        let path = scratch("future");
        let mut registry = Registry::default();

        registry.version = REGISTRY_VERSION + 1;
        write_document(&path, &registry).expect("write");

        let (parsed, degraded, read_only) = read_document(&path);

        assert!(parsed.is_some());
        assert_eq!(degraded.as_deref(), Some("future-version"));
        assert!(read_only);
        assert!(
            !path.with_file_name(BACKUP_NAME).exists(),
            "a newer doc is not backed up away"
        );
    }

    #[test]
    fn an_oversize_document_degrades_rather_than_being_parsed() {
        let path = scratch("oversize");

        std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        std::fs::write(&path, "x".repeat(MAX_DOCUMENT_BYTES + 1)).expect("seed");

        let (parsed, degraded, _) = read_document(&path);

        assert!(parsed.is_none());
        assert_eq!(degraded.as_deref(), Some("oversize"));
    }
}
