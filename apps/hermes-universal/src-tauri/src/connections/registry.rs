//! The connection registry document — the PURE half.
//!
//! Everything here decides; nothing here touches the filesystem, the keyring, a
//! socket or the app handle. That split is rule 35 and the reason this file can
//! be unit-tested with no device attached: `normalize_registry`, the label
//! grammar, the duplicate-target rules, the migration from the pre-registry
//! `GatewayTarget` and the roster collapse are all total functions over plain
//! data, and every one of them is a rule that used to live implicitly in the
//! frontend's single-connection assumptions.
//!
//! The one property to protect above all others: for the PRIMARY (migrated,
//! single) connection every derived key collapses to the value it had before a
//! registry existed. `registry_backend_scope_key("local", p) == p` is what keeps
//! `ssh_ownership_id` byte-identical, which is what keeps an upgrade from
//! orphaning a remote backend that is still running. `scope_key_pin` in the
//! tests below is the cross-language pin against `src/lib/backend-scope.ts`
//! (MJXHRM-480 owns the values; this is the mirror).

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use super::error::{ConnectionsError, ConnectionsErrorKind};

/// The document version this build writes. A HIGHER version on disk is read-only
/// (§6.6): a downgrade must not be able to destroy a newer install's sources.
pub const REGISTRY_VERSION: u32 = 2;

/// The reserved id of the local-spawn entry. Byte-identical to
/// `LOCAL_CONNECTION_ID` in `src/lib/backend-scope.ts` — pinned by a test on
/// both sides, because drift here silently re-keys every pool entry.
pub const LOCAL_CONNECTION_ID: &str = "local";

pub const LABEL_MAX: usize = 64;
pub const MAX_CONNECTIONS: usize = 64;
pub const MAX_DOCUMENT_BYTES: usize = 64 * 1024;
pub const MAX_HEADER_NAMES: usize = 8;
pub const MAX_HEADER_VALUE_BYTES: usize = 4 * 1024;

/// Header names a connection may NOT carry. Transport and auth headers are the
/// transport's own business: letting a stored header set `Authorization` would
/// hand the registry a way to overwrite the bearer `oauth.rs` attaches, and the
/// `Sec-WebSocket-*` family would corrupt the upgrade outright.
const HEADER_DENY_LIST: &[&str] = &[
    "authorization",
    "cookie",
    "host",
    "content-length",
    "connection",
    "upgrade",
    "transfer-encoding",
];

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "kebab-case")]
pub enum ConnectionKind {
    Cloud,
    Local,
    Remote,
    Ssh,
}

impl ConnectionKind {
    /// Which connection wins when several address the same backend (§8.10 step
    /// 3). A total order over a closed enum, deliberately a table rather than a
    /// trait method: a kind that forgot to declare a priority would silently
    /// sort last, and the `match` here makes the compiler ask.
    pub fn canonical_priority(self) -> u8 {
        match self {
            Self::Local => 0,
            Self::Ssh => 1,
            Self::Remote => 2,
            Self::Cloud => 3,
        }
    }

    /// The gateway MODE this kind dials as — the frontend's `GatewayMode`.
    pub fn mode(self) -> &'static str {
        match self {
            Self::Cloud => "cloud",
            Self::Local => "local",
            Self::Remote => "remote",
            Self::Ssh => "ssh",
        }
    }
}

/// How a registered source authenticates. Narrower than the frontend's
/// `AuthMode` on purpose: `ticket` is a runtime OUTCOME of a gated connect (the
/// operator supplied a password), never a stored preference.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum AuthMode {
    #[default]
    None,
    Oauth,
    Token,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum LaunchMode {
    #[default]
    LastUsed,
    Primary,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub id: String,
    pub kind: ConnectionKind,
    /// REQUIRED, registry-unique case-insensitively. The "device name".
    pub label: String,
    /// Registration order, so the canonical pick is stable. Never renumbered.
    pub order: u32,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_mode: Option<AuthMode>,
    /// Header NAMES only. The VALUES live in the keyring (§6.2) — the one place
    /// universal diverges from desktop, which stored encrypted envelopes in the
    /// document itself.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub header_names: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub org: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_hermes_path: Option<String>,
    /// The ONE remote profile this backend runs AS.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_profile: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Registry {
    pub version: u32,
    /// An existing id; a dangling value is repaired to the first entry.
    pub primary: String,
    #[serde(default)]
    pub launch_mode: LaunchMode,
    /// Falls back to `primary` when missing or dangling.
    #[serde(default)]
    pub last_used: String,
    /// The connection that INHERITED the pre-registry world: the bare keyring
    /// accounts and the bare pool/ownership scope.
    ///
    /// Written once, by the migration, and never rewritten — not even by
    /// `set_primary`. Tying it to `primary` instead would mean promoting another
    /// gateway silently re-keys two installs' credentials and orphans whatever
    /// remote backend the old primary still has running.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub legacy_id: Option<String>,
    #[serde(default)]
    pub connections: Vec<Connection>,
}

impl Default for Registry {
    fn default() -> Self {
        Self {
            version: REGISTRY_VERSION,
            primary: LOCAL_CONNECTION_ID.to_string(),
            launch_mode: LaunchMode::LastUsed,
            last_used: LOCAL_CONNECTION_ID.to_string(),
            legacy_id: Some(LOCAL_CONNECTION_ID.to_string()),
            connections: Vec::new(),
        }
    }
}

/// The editor's payload. Every secret field is WRITE-ONLY: consumed into the
/// keyring by `connections::secrets` and never echoed back on any read.
#[derive(Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInput {
    /// Absent = create.
    #[serde(default)]
    pub id: Option<String>,
    pub kind: ConnectionKind,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub auth_mode: Option<AuthMode>,
    /// `Some("")` deletes the stored token; `None` leaves it alone.
    #[serde(default)]
    pub token: Option<String>,
    #[serde(default)]
    pub headers: Option<BTreeMap<String, String>>,
    #[serde(default)]
    pub org: Option<String>,
    #[serde(default)]
    pub host: Option<String>,
    #[serde(default)]
    pub user: Option<String>,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub key_path: Option<String>,
    #[serde(default)]
    pub remote_hermes_path: Option<String>,
    #[serde(default)]
    pub remote_profile: Option<String>,
    #[serde(default)]
    pub private_key_pem: Option<String>,
    #[serde(default)]
    pub passphrase: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
}

// `ConnectionKind` has no natural default; `Default` on the input is only for
// tests and for serde's field-level defaults, so pick the kind that needs the
// fewest other fields to be valid.
impl Default for ConnectionKind {
    fn default() -> Self {
        Self::Remote
    }
}

/// Whether "Update everything" may target a source, and why not when it may not.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Eligibility {
    pub eligible: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

// --------------------------------------------------------------------------
// Scope keys — the Rust mirror of `src/lib/backend-scope.ts` (MJXHRM-480)
// --------------------------------------------------------------------------

/// `backendScopeKey` — the pool key. The local/primary connection keeps the BARE
/// profile so every legacy pool entry stays byte-identical.
pub fn backend_scope_key(connection_id: Option<&str>, profile: Option<&str>) -> String {
    let profile_key = normalize_profile(profile);
    let connection = connection_id.unwrap_or("").trim();

    if connection.is_empty() || connection == LOCAL_CONNECTION_ID {
        return profile_key;
    }

    format!("conn:{connection}::{profile_key}")
}

/// `registryBackendScopeKey` — scope a registry route WITHOUT collapsing an
/// explicit `local` id. Only an absent/empty id means the legacy profile route.
pub fn registry_backend_scope_key(connection_id: Option<&str>, profile: Option<&str>) -> String {
    let profile_key = normalize_profile(profile);
    let connection = connection_id.unwrap_or("").trim();

    if connection.is_empty() {
        return profile_key;
    }

    format!("conn:{connection}::{profile_key}")
}

fn normalize_profile(profile: Option<&str>) -> String {
    let trimmed = profile.unwrap_or("").trim();

    if trimmed.is_empty() {
        "default".to_string()
    } else {
        trimmed.to_string()
    }
}

// --------------------------------------------------------------------------
// The label / id grammar
// --------------------------------------------------------------------------

/// The case-insensitive identity of a label. Uniqueness is checked on this, so
/// "Studio" and " studio " are the same name.
pub fn label_key(label: &str) -> String {
    label.trim().to_lowercase()
}

/// A label as an id fragment: lowercase, non-alphanumerics collapsed to `-`,
/// trimmed. Never empty for a non-empty input — a label of only punctuation
/// still has to produce something addressable.
pub fn label_slug(label: &str) -> String {
    let mut out = String::new();
    let mut pending_dash = false;

    for ch in label.trim().chars() {
        if ch.is_ascii_alphanumeric() {
            if pending_dash && !out.is_empty() {
                out.push('-');
            }

            pending_dash = false;
            out.push(ch.to_ascii_lowercase());
        } else {
            pending_dash = true;
        }
    }

    if out.is_empty() && !label.trim().is_empty() {
        // A label of pure punctuation or non-ASCII script still needs an id.
        // Hashing would be opaque; a fixed stem plus the collision suffix that
        // `connection_id_for_label` appends stays readable.
        return "source".to_string();
    }

    out
}

/// A label that is unique among `taken`, counting up. Reserves 4 characters for
/// the ` N` suffix so a clamp can never produce `"X 2 2"`.
pub fn unique_label(desired: &str, taken: &BTreeSet<String>) -> String {
    let stem_max = LABEL_MAX.saturating_sub(4);
    let base = clamp_chars(desired.trim(), stem_max);
    let base = if base.is_empty() {
        "Gateway".to_string()
    } else {
        base
    };

    if !taken.contains(&label_key(&base)) {
        return base;
    }

    for n in 2..1000 {
        let candidate = format!("{base} {n}");

        if !taken.contains(&label_key(&candidate)) {
            return candidate;
        }
    }

    format!("{base} {}", taken.len() + 1)
}

fn clamp_chars(value: &str, max: usize) -> String {
    value
        .chars()
        .take(max)
        .collect::<String>()
        .trim()
        .to_string()
}

/// Mint an id for a new connection. Never `"local"` for a non-local kind — that
/// id is reserved, and a remote entry holding it would read every local
/// credential out of the bare keyring accounts (§6.2's carve-out).
pub fn connection_id_for_label(
    label: &str,
    kind: ConnectionKind,
    taken: &BTreeSet<String>,
) -> String {
    if kind == ConnectionKind::Local {
        return LOCAL_CONNECTION_ID.to_string();
    }

    let stem = label_slug(label);
    let stem = if stem.is_empty() || stem == LOCAL_CONNECTION_ID {
        format!("{stem}-source").trim_start_matches('-').to_string()
    } else {
        stem
    };
    let stem = clamp_chars(&stem, LABEL_MAX.saturating_sub(4));

    if !taken.contains(&stem) {
        return stem;
    }

    for n in 2..1000 {
        let candidate = format!("{stem}-{n}");

        if !taken.contains(&candidate) {
            return candidate;
        }
    }

    format!("{stem}-{}", taken.len() + 1)
}

// --------------------------------------------------------------------------
// Normalization
// --------------------------------------------------------------------------

/// One URL grammar, shared by `remote` and `cloud`.
///
/// Auto-prepends `http://` for a scheme-less `host:port`, because
/// `Url::parse("100.64.0.1:9119")` reads `100.64.0.1:` as the SCHEME and would
/// otherwise accept a nonsense target. An explicit non-HTTP scheme is still
/// rejected — a branch, not a strategy (§9.5).
pub fn normalize_remote_base_url(raw: &str) -> Result<String, ConnectionsError> {
    let value = raw.trim();

    if value.is_empty() {
        return Err(ConnectionsError::invalid("a gateway URL is required"));
    }

    let lower = value.to_ascii_lowercase();
    let candidate = if lower.starts_with("http://") || lower.starts_with("https://") {
        value.to_string()
    } else if value.contains("://") {
        return Err(ConnectionsError::invalid(format!(
            "{value} is not an http(s) URL"
        )));
    } else {
        format!("http://{value}")
    };

    let parsed = reqwest::Url::parse(&candidate)
        .map_err(|_| ConnectionsError::invalid(format!("{value} is not a valid URL")))?;

    if parsed.host_str().unwrap_or("").is_empty() {
        return Err(ConnectionsError::invalid(format!("{value} has no host")));
    }

    Ok(candidate.trim_end_matches('/').to_string())
}

/// Filter header names through the deny list. Returns the accepted names
/// (lowercased) and the rejected ones, because a silently dropped header is how
/// a Cloudflare-Access source fails with no explanation (rule 9).
pub fn normalize_remote_headers(
    names: impl IntoIterator<Item = String>,
) -> (Vec<String>, Vec<String>) {
    let mut kept: Vec<String> = Vec::new();
    let mut dropped: Vec<String> = Vec::new();

    for name in names {
        let lower = name.trim().to_ascii_lowercase();

        if lower.is_empty() {
            continue;
        }

        if HEADER_DENY_LIST.contains(&lower.as_str())
            || lower.starts_with("sec-websocket")
            || kept.contains(&lower)
        {
            if !kept.contains(&lower) {
                dropped.push(lower);
            }

            continue;
        }

        kept.push(lower);
    }

    (kept, dropped)
}

/// The identity two entries must not share. `remote` and `cloud` collide on the
/// same URL deliberately: they are the same box reached the same way.
pub fn dial_identity(connection: &Connection) -> String {
    match connection.kind {
        ConnectionKind::Local => "local".to_string(),
        ConnectionKind::Cloud | ConnectionKind::Remote => {
            format!("url:{}", connection.url.clone().unwrap_or_default())
        }
        ConnectionKind::Ssh => format!(
            "ssh:{}@{}:{}#{}",
            connection.user.clone().unwrap_or_default(),
            connection.host.clone().unwrap_or_default(),
            connection.port.unwrap_or(22),
            connection.remote_profile.clone().unwrap_or_default()
        ),
    }
}

/// Which stored fields recycle every pooled backend and live socket when they
/// change. The LABEL is never one — renaming a device must not drop its traffic.
pub fn dial_fields(connection: &Connection) -> Vec<(&'static str, String)> {
    let mut fields = vec![
        ("kind", connection.kind.mode().to_string()),
        ("dial", dial_identity(connection)),
    ];

    match connection.kind {
        ConnectionKind::Cloud | ConnectionKind::Remote => {
            fields.push((
                "authMode",
                serde_json::to_string(&connection.auth_mode.unwrap_or_default())
                    .unwrap_or_default(),
            ));
            fields.push(("headers", connection.header_names.join(",")));
            fields.push(("org", connection.org.clone().unwrap_or_default()));
        }
        ConnectionKind::Ssh => {
            fields.push(("keyPath", connection.key_path.clone().unwrap_or_default()));
            fields.push((
                "remoteHermesPath",
                connection.remote_hermes_path.clone().unwrap_or_default(),
            ));
        }
        ConnectionKind::Local => {}
    }

    fields
}

/// Did an edit change anything a live socket depends on?
pub fn dial_fields_changed(before: &Connection, after: &Connection) -> bool {
    dial_fields(before) != dial_fields(after)
}

pub fn update_eligibility(kind: ConnectionKind) -> Eligibility {
    match kind {
        ConnectionKind::Cloud => Eligibility {
            eligible: false,
            reason: Some("cloud-managed".to_string()),
        },
        _ => Eligibility {
            eligible: true,
            reason: None,
        },
    }
}

/// Validate + normalize the editor's payload into a stored descriptor.
///
/// `existing` is the row being edited, when there is one: it carries the fields
/// the editor does not collect (an ssh `org`, a cloud `remoteProfile`) so a save
/// from a narrower form cannot erase them.
pub fn normalize_connection_input(
    input: &ConnectionInput,
    existing: Option<&Connection>,
    order: u32,
    taken_ids: &BTreeSet<String>,
    taken_labels: &BTreeSet<String>,
) -> Result<(Connection, Vec<String>), ConnectionsError> {
    let label = input.label.trim();

    if label.is_empty() {
        return Err(ConnectionsError::invalid("a name is required"));
    }

    if label.chars().count() > LABEL_MAX {
        return Err(ConnectionsError::invalid(format!(
            "a name may be at most {LABEL_MAX} characters"
        )));
    }

    if taken_labels.contains(&label_key(label)) {
        return Err(ConnectionsError::new(
            ConnectionsErrorKind::DuplicateLabel,
            format!("another gateway is already called \"{label}\""),
        ));
    }

    let kind = existing.map_or(input.kind, |row| row.kind);
    let id = match existing {
        Some(row) => row.id.clone(),
        None => connection_id_for_label(label, kind, taken_ids),
    };

    if id == LOCAL_CONNECTION_ID && kind != ConnectionKind::Local {
        return Err(ConnectionsError::new(
            ConnectionsErrorKind::ReservedId,
            "\"local\" is reserved for this device's own backend",
        ));
    }

    let mut dropped_headers = Vec::new();

    let mut connection = Connection {
        id,
        kind,
        label: label.to_string(),
        order: existing.map_or(order, |row| row.order),
        url: None,
        auth_mode: None,
        header_names: Vec::new(),
        org: None,
        host: None,
        user: None,
        port: None,
        key_path: None,
        remote_hermes_path: None,
        remote_profile: None,
    };

    match kind {
        ConnectionKind::Local => {}
        ConnectionKind::Cloud | ConnectionKind::Remote => {
            let raw = input
                .url
                .clone()
                .or_else(|| existing.and_then(|row| row.url.clone()))
                .unwrap_or_default();

            connection.url = Some(normalize_remote_base_url(&raw)?);
            connection.auth_mode = Some(
                input
                    .auth_mode
                    .or_else(|| existing.and_then(|row| row.auth_mode))
                    .unwrap_or_default(),
            );
            connection.org = input
                .org
                .clone()
                .or_else(|| existing.and_then(|row| row.org.clone()))
                .filter(|value| !value.trim().is_empty());

            let names = match &input.headers {
                Some(headers) => {
                    for (name, value) in headers {
                        if value.len() > MAX_HEADER_VALUE_BYTES {
                            return Err(ConnectionsError::invalid(format!(
                                "the value for header \"{name}\" is too long"
                            )));
                        }
                    }

                    headers.keys().cloned().collect::<Vec<_>>()
                }
                None => existing
                    .map(|row| row.header_names.clone())
                    .unwrap_or_default(),
            };

            let (kept, dropped) = normalize_remote_headers(names);

            if kept.len() > MAX_HEADER_NAMES {
                return Err(ConnectionsError::invalid(format!(
                    "at most {MAX_HEADER_NAMES} extra headers are supported"
                )));
            }

            connection.header_names = kept;
            dropped_headers = dropped;
        }
        ConnectionKind::Ssh => {
            let host = input
                .host
                .clone()
                .or_else(|| existing.and_then(|row| row.host.clone()))
                .unwrap_or_default();
            let host = host.trim();

            if host.is_empty() {
                return Err(ConnectionsError::invalid("an SSH host is required"));
            }

            // `user@host:port` typed into the host field beats the stored parts:
            // the user just re-typed the whole target, so the pieces they did
            // not re-type are the stale ones.
            let (typed_user, host_only, typed_port) = split_ssh_host(host);

            connection.host = Some(host_only);
            connection.user = typed_user
                .or_else(|| input.user.clone())
                .or_else(|| existing.and_then(|row| row.user.clone()))
                .filter(|value| !value.trim().is_empty())
                .map(|value| value.trim().to_string());
            connection.port = typed_port
                .or(input.port)
                .or_else(|| existing.and_then(|row| row.port));
            connection.key_path = input
                .key_path
                .clone()
                .or_else(|| existing.and_then(|row| row.key_path.clone()))
                .filter(|value| !value.trim().is_empty());
            connection.remote_hermes_path = input
                .remote_hermes_path
                .clone()
                .or_else(|| existing.and_then(|row| row.remote_hermes_path.clone()))
                .filter(|value| !value.trim().is_empty());
            connection.remote_profile = input
                .remote_profile
                .clone()
                .or_else(|| existing.and_then(|row| row.remote_profile.clone()))
                .filter(|value| !value.trim().is_empty());
        }
    }

    Ok((connection, dropped_headers))
}

/// `user@host:port` → its three parts. Anything the string does not carry stays
/// `None` so the caller can fall back to what it already had.
fn split_ssh_host(raw: &str) -> (Option<String>, String, Option<u16>) {
    let (user, rest) = match raw.split_once('@') {
        Some((user, rest)) if !user.trim().is_empty() => (Some(user.trim().to_string()), rest),
        _ => (None, raw),
    };

    let (host, port) = match rest.rsplit_once(':') {
        Some((host, port)) => match port.trim().parse::<u16>() {
            Ok(parsed) => (host, Some(parsed)),
            Err(_) => (rest, None),
        },
        None => (rest, None),
    };

    (user, host.trim().to_string(), port)
}

/// Merge a normalized entry into the registry, enforcing the duplicate rules.
pub fn merge_connection_input(
    registry: &mut Registry,
    connection: Connection,
) -> Result<bool, ConnectionsError> {
    let identity = dial_identity(&connection);

    if let Some(clash) = registry
        .connections
        .iter()
        .find(|row| row.id != connection.id && dial_identity(row) == identity)
    {
        return Err(ConnectionsError::new(
            ConnectionsErrorKind::DuplicateTarget,
            format!("\"{}\" already points at that backend", clash.label),
        ));
    }

    match registry
        .connections
        .iter()
        .position(|row| row.id == connection.id)
    {
        Some(index) => {
            let changed = dial_fields_changed(&registry.connections[index], &connection);

            registry.connections[index] = connection;

            Ok(changed)
        }
        None => {
            if registry.connections.len() >= MAX_CONNECTIONS {
                return Err(ConnectionsError::new(
                    ConnectionsErrorKind::RegistryFull,
                    format!("this device can hold at most {MAX_CONNECTIONS} gateways"),
                ));
            }

            registry.connections.push(connection);

            Ok(true)
        }
    }
}

/// Repair a document into something dialable, and SAY when it had to.
///
/// Desktop degrades silently; universal reports (`degraded`) because "you have
/// one gateway" is indistinguishable from "your registry was eaten" otherwise.
pub fn normalize_registry(registry: &mut Registry, local_supported: bool) -> Option<String> {
    let mut degraded: Option<String> = None;
    let mut note = |reason: &str| {
        if degraded.is_none() {
            degraded = Some(reason.to_string());
        }
    };

    registry.version = REGISTRY_VERSION;

    if registry.connections.len() > MAX_CONNECTIONS {
        registry.connections.truncate(MAX_CONNECTIONS);
        note("too-many");
    }

    let mut seen_ids: BTreeSet<String> = BTreeSet::new();
    let mut seen_labels: BTreeSet<String> = BTreeSet::new();
    let mut seen_targets: BTreeSet<String> = BTreeSet::new();
    let mut seen_local = false;
    let mut kept: Vec<Connection> = Vec::new();

    for mut row in std::mem::take(&mut registry.connections) {
        row.id = row.id.trim().to_string();

        if row.id.is_empty() || seen_ids.contains(&row.id) {
            note("duplicate-id");

            continue;
        }

        if row.kind == ConnectionKind::Local {
            if !local_supported {
                // A registry hand-copied from a desktop onto a phone: drop the
                // dead row LOUDLY rather than showing something undialable.
                note("local-unsupported");

                continue;
            }

            if seen_local {
                note("duplicate-local");

                continue;
            }

            seen_local = true;
            row.id = LOCAL_CONNECTION_ID.to_string();
        } else if row.id == LOCAL_CONNECTION_ID {
            note("reserved-id");

            continue;
        }

        let label = row.label.trim().to_string();
        let label = if label.is_empty() {
            note("missing-label");

            row.kind.mode().to_string()
        } else {
            clamp_chars(&label, LABEL_MAX)
        };

        row.label = unique_label(&label, &seen_labels);

        if row.label != label {
            note("duplicate-label");
        }

        let identity = dial_identity(&row);

        if !seen_targets.insert(identity) {
            note("duplicate-target");

            continue;
        }

        seen_labels.insert(label_key(&row.label));
        seen_ids.insert(row.id.clone());
        row.order = kept.len() as u32;
        kept.push(row);
    }

    registry.connections = kept;

    if registry.connections.is_empty() && local_supported {
        registry.connections.push(local_connection());
        registry
            .legacy_id
            .get_or_insert_with(|| LOCAL_CONNECTION_ID.to_string());
    }

    let first = registry
        .connections
        .first()
        .map(|row| row.id.clone())
        .unwrap_or_else(|| LOCAL_CONNECTION_ID.to_string());

    if !registry
        .connections
        .iter()
        .any(|row| row.id == registry.primary)
    {
        registry.primary = first.clone();
    }

    if !registry
        .connections
        .iter()
        .any(|row| row.id == registry.last_used)
    {
        registry.last_used = registry.primary.clone();
    }

    // A legacy owner that is no longer registered is not re-pointed at another
    // row: the bare accounts belonged to the connection the user removed, and
    // handing them to a different gateway would dial it with someone else's
    // token. `None` simply means every surviving connection is scope-keyed.
    if registry
        .legacy_id
        .as_ref()
        .is_some_and(|id| !registry.connections.iter().any(|row| &row.id == id))
    {
        registry.legacy_id = None;
    }

    degraded
}

/// Does this connection own the pre-registry (bare) keyring accounts and pool
/// scope? Exactly one connection can, and it is chosen once by the migration.
pub fn is_legacy_connection(registry: &Registry, id: &str) -> bool {
    registry.legacy_id.as_deref() == Some(id)
}

/// The connection id a DIAL should carry.
///
/// `None` for the legacy owner — that is the whole collapse: `backend_scope_key`
/// and `ssh_ownership_id` then see the bare profile they saw before the registry
/// existed, so an upgrade REATTACHES to a running remote backend instead of
/// spawning a second one beside it.
pub fn dial_connection_id<'a>(registry: &Registry, id: &'a str) -> Option<&'a str> {
    if is_legacy_connection(registry, id) {
        None
    } else {
        Some(id)
    }
}

/// The local-spawn entry. Reserved id, not removable where it exists.
pub fn local_connection() -> Connection {
    Connection {
        id: LOCAL_CONNECTION_ID.to_string(),
        kind: ConnectionKind::Local,
        label: "This device".to_string(),
        order: 0,
        url: None,
        auth_mode: None,
        header_names: Vec::new(),
        org: None,
        host: None,
        user: None,
        port: None,
        key_path: None,
        remote_hermes_path: None,
        remote_profile: None,
    }
}

// --------------------------------------------------------------------------
// Migration from the pre-registry `GatewayTarget`
// --------------------------------------------------------------------------

/// Mint the FIRST registry from what the webview has in `hermes.connection.last`.
///
/// The one entry it produces becomes both `primary` and `lastUsed`, which is
/// what makes its scope key collapse to the bare profile — the reason an upgrade
/// reattaches to a running remote backend instead of orphaning it (§8.6).
pub fn migrate_from_v1_target(
    target: Option<&serde_json::Value>,
    local_supported: bool,
) -> Registry {
    let mut registry = Registry {
        version: REGISTRY_VERSION,
        primary: LOCAL_CONNECTION_ID.to_string(),
        launch_mode: LaunchMode::LastUsed,
        last_used: LOCAL_CONNECTION_ID.to_string(),
        legacy_id: local_supported.then(|| LOCAL_CONNECTION_ID.to_string()),
        connections: Vec::new(),
    };

    if local_supported {
        registry.connections.push(local_connection());
    }

    let Some(target) = target else {
        normalize_registry(&mut registry, local_supported);

        return registry;
    };

    let str_at = |key: &str| -> Option<String> {
        target
            .get(key)
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    };
    let ssh = target.get("ssh");
    let ssh_str = |key: &str| -> Option<String> {
        ssh.and_then(|value| value.get(key))
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    };

    let mode = str_at("mode").unwrap_or_else(|| "remote".to_string());

    let migrated = match mode.as_str() {
        "local" => local_supported.then(local_connection),
        "cloud" => str_at("cloudBaseUrl").and_then(|raw| {
            normalize_remote_base_url(&raw).ok().map(|url| {
                let label = str_at("cloudAgentName").unwrap_or_else(|| host_label(&url));

                Connection {
                    id: connection_id_for_label(&label, ConnectionKind::Cloud, &BTreeSet::new()),
                    kind: ConnectionKind::Cloud,
                    label,
                    order: 0,
                    url: Some(url),
                    auth_mode: Some(AuthMode::Oauth),
                    header_names: Vec::new(),
                    org: None,
                    host: None,
                    user: None,
                    port: None,
                    key_path: None,
                    remote_hermes_path: None,
                    remote_profile: None,
                }
            })
        }),
        "ssh" => ssh_str("host").map(|host| {
            let (typed_user, host_only, typed_port) = split_ssh_host(&host);
            let user = typed_user.or_else(|| ssh_str("user"));
            let label = match &user {
                Some(user) => format!("{user}@{host_only}"),
                None => host_only.clone(),
            };

            Connection {
                id: connection_id_for_label(&label, ConnectionKind::Ssh, &BTreeSet::new()),
                kind: ConnectionKind::Ssh,
                label,
                order: 0,
                url: None,
                auth_mode: None,
                header_names: Vec::new(),
                org: None,
                host: Some(host_only),
                user,
                port: typed_port.or_else(|| {
                    ssh.and_then(|value| value.get("port"))
                        .and_then(serde_json::Value::as_u64)
                        .and_then(|value| u16::try_from(value).ok())
                }),
                key_path: ssh_str("keyPath"),
                remote_hermes_path: ssh_str("remoteHermesPath"),
                remote_profile: str_at("profile"),
            }
        }),
        _ => str_at("url").and_then(|raw| {
            normalize_remote_base_url(&raw).ok().map(|url| {
                let label = host_label(&url);

                Connection {
                    id: connection_id_for_label(&label, ConnectionKind::Remote, &BTreeSet::new()),
                    kind: ConnectionKind::Remote,
                    label,
                    order: 0,
                    url: Some(url),
                    // The pre-registry remote path negotiates its auth on every
                    // connect; `none` is the honest stored answer until a save
                    // says otherwise, and it never gates a dial.
                    auth_mode: Some(AuthMode::None),
                    header_names: Vec::new(),
                    org: None,
                    host: None,
                    user: None,
                    port: None,
                    key_path: None,
                    remote_hermes_path: None,
                    remote_profile: None,
                }
            })
        }),
    };

    if let Some(mut connection) = migrated {
        connection.order = registry.connections.len() as u32;

        let id = connection.id.clone();

        if !registry.connections.iter().any(|row| row.id == id) {
            registry.connections.push(connection);
        }

        registry.primary = id.clone();
        registry.last_used = id.clone();
        // THE compatibility hinge: this entry is the app as it was before the
        // registry existed, so it keeps the bare keyring accounts and the bare
        // pool scope. On a desktop the `local` row is already the legacy owner,
        // and a migrated remote/ssh/cloud entry takes that role instead only
        // when there is none.
        if registry.legacy_id.is_none() {
            registry.legacy_id = Some(id);
        }
    }

    normalize_registry(&mut registry, local_supported);

    registry
}

fn host_label(url: &str) -> String {
    reqwest::Url::parse(url)
        .ok()
        .and_then(|parsed| parsed.host_str().map(str::to_string))
        .unwrap_or_else(|| url.to_string())
}

// --------------------------------------------------------------------------
// The agent roster (§8.10)
// --------------------------------------------------------------------------

/// What one source reported, before the collapse.
#[derive(Debug, Clone)]
pub struct SourceProfiles {
    pub connection_id: String,
    pub kind: ConnectionKind,
    pub label: String,
    pub order: u32,
    /// `None` = the source did not answer. An unreachable source contributes
    /// NOTHING; it must not be able to shrink the roster or fake a duplicate.
    pub profiles: Option<Vec<String>>,
    pub install_id: Option<String>,
    pub error: Option<String>,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RosterAgent {
    pub connection_id: String,
    pub profile: String,
    /// `profile` when unique, `profile-label-slug` when two BOXES share it.
    pub handle: String,
    pub label: String,
    pub is_default: bool,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RosterSource {
    pub connection_id: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct AgentRoster {
    pub agents: Vec<RosterAgent>,
    pub sources: Vec<RosterSource>,
}

/// `profile` when it names one box, `profile-<device>` when it names two.
pub fn agent_handle(profile: &str, label: &str, duplicated: bool) -> String {
    if duplicated {
        format!("{profile}-{}", label_slug(label))
    } else {
        profile.to_string()
    }
}

/// Which connection speaks for a backend several connections can reach.
///
/// The ACTIVE one when it is a candidate — the user is looking at it — then the
/// kind priority, then registration order.
pub fn pick_canonical_connection<'a>(
    candidates: &[&'a SourceProfiles],
    active_connection_id: Option<&str>,
) -> &'a SourceProfiles {
    if let Some(active) = active_connection_id {
        if let Some(found) = candidates.iter().find(|row| row.connection_id == active) {
            return found;
        }
    }

    candidates
        .iter()
        .min_by_key(|row| {
            (
                row.kind.canonical_priority(),
                row.order,
                row.connection_id.clone(),
            )
        })
        .expect("pick_canonical_connection needs at least one candidate")
}

/// Collapse the per-source reports into one routable agent per backend+profile.
///
/// The order is the point: collapse by backend identity FIRST, then apply the
/// `@name-device` disambiguation. A profile that only *looked* duplicated (one
/// box, two addresses) keeps its bare name.
pub fn build_agent_roster(
    sources: &[SourceProfiles],
    active_connection_id: Option<&str>,
) -> AgentRoster {
    let mut buckets: Vec<(String, Vec<&SourceProfiles>, String)> = Vec::new();

    for source in sources {
        let Some(profiles) = &source.profiles else {
            continue;
        };

        // Step 1: a source can report a profile twice.
        let mut seen: BTreeSet<String> = BTreeSet::new();

        for profile in profiles {
            let profile = profile.trim();

            if profile.is_empty() || !seen.insert(profile.to_string()) {
                continue;
            }

            // Step 2: collapse by BACKEND identity. A missing install_id bypasses
            // the collapse entirely — an older backend keeps today's behaviour
            // rather than folding into every other unidentified one.
            let key = match &source.install_id {
                Some(install) => format!("id:{install}\0{profile}"),
                None => format!("conn:{}\0{profile}", source.connection_id),
            };

            match buckets.iter_mut().find(|(bucket, _, _)| bucket == &key) {
                Some((_, members, _)) => members.push(source),
                None => buckets.push((key, vec![source], profile.to_string())),
            }
        }
    }

    // Step 4: only NOW is a profile name duplicated — across distinct backends.
    let mut profile_counts: BTreeMap<String, usize> = BTreeMap::new();

    for (_, _, profile) in &buckets {
        *profile_counts.entry(profile.clone()).or_insert(0) += 1;
    }

    let mut agents: Vec<RosterAgent> = Vec::new();

    for (_, members, profile) in &buckets {
        let canonical = pick_canonical_connection(members, active_connection_id);
        let duplicated = profile_counts.get(profile).copied().unwrap_or(0) > 1;

        agents.push(RosterAgent {
            connection_id: canonical.connection_id.clone(),
            handle: agent_handle(profile, &canonical.label, duplicated),
            is_default: profile == "default",
            label: canonical.label.clone(),
            profile: profile.clone(),
        });
    }

    agents.sort_by(|a, b| (&a.connection_id, &a.profile).cmp(&(&b.connection_id, &b.profile)));

    AgentRoster {
        agents,
        sources: sources
            .iter()
            .map(|source| RosterSource {
                connection_id: source.connection_id.clone(),
                error: source.error.clone(),
                ok: source.profiles.is_some(),
            })
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// THE cross-language scope-key table (reconciliation M1).
    ///
    /// `src/lib/backend-scope.test.ts` reads these lines out of this file and
    /// asserts the TS functions produce the same answers, because nothing else
    /// pins the two languages to each other and a drift is silent until an
    /// upgrade orphans a running remote backend (the `data_url_read_max.rs`
    /// precedent).
    ///
    /// Flat strings rather than tuples ON PURPOSE: rustfmt reflows a tuple
    /// across four lines the moment it grows past the width, and a table whose
    /// shape depends on the formatter is a table the other language cannot
    /// read. One row per line survives `cargo fmt`.
    ///
    /// `connectionId|profile|backendScopeKey|registryBackendScopeKey`, with `~`
    /// for a `None` argument — distinct from `""`, which is its own case.
    const SCOPE_KEY_PIN: &[&str] = &[
        "~|~|default|default",
        "||default|default",
        "local|default|default|conn:local::default",
        "local|work|work|conn:local::work",
        "~|work|work|work",
        "box-2|default|conn:box-2::default|conn:box-2::default",
        "box-2|~|conn:box-2::default|conn:box-2::default",
        " box-2 | work |conn:box-2::work|conn:box-2::work",
    ];

    fn remote(id: &str, label: &str, url: &str, order: u32) -> Connection {
        Connection {
            id: id.to_string(),
            kind: ConnectionKind::Remote,
            label: label.to_string(),
            order,
            url: Some(url.to_string()),
            auth_mode: Some(AuthMode::None),
            header_names: Vec::new(),
            org: None,
            host: None,
            user: None,
            port: None,
            key_path: None,
            remote_hermes_path: None,
            remote_profile: None,
        }
    }

    fn source(
        id: &str,
        label: &str,
        kind: ConnectionKind,
        order: u32,
        profiles: Option<&[&str]>,
        install: Option<&str>,
    ) -> SourceProfiles {
        SourceProfiles {
            connection_id: id.to_string(),
            error: None,
            install_id: install.map(str::to_string),
            kind,
            label: label.to_string(),
            order,
            profiles: profiles.map(|list| list.iter().map(|value| value.to_string()).collect()),
        }
    }

    // --- the cross-language pin (reconciliation M1) ------------------------
    //
    // The SAME table is asserted in `src/lib/backend-scope.test.ts`. Drift here
    // is silent and orphans a remote backend, so both languages read one table.

    #[test]
    fn scope_key_pin() {
        assert_eq!(LOCAL_CONNECTION_ID, "local");

        for row in SCOPE_KEY_PIN {
            let cells: Vec<&str> = row.split('|').collect();
            let arg = |cell: &'static str| if cell == "~" { None } else { Some(cell) };
            let (id, profile, pooled, registry) = (
                arg(cells[0]),
                arg(cells[1]),
                cells[2].to_string(),
                cells[3].to_string(),
            );

            assert_eq!(backend_scope_key(id, profile), pooled, "row {row}");
            assert_eq!(
                registry_backend_scope_key(id, profile),
                registry,
                "row {row}"
            );
        }
    }

    #[test]
    fn label_key_is_case_insensitive_and_trimmed() {
        assert_eq!(label_key("  Studio  "), "studio");
        assert_eq!(label_key("STUDIO"), label_key("studio"));
    }

    #[test]
    fn label_slug_kebabs_and_never_empties_a_non_empty_label() {
        assert_eq!(label_slug("Studio Box"), "studio-box");
        assert_eq!(label_slug("  a__b  "), "a-b");
        assert_eq!(label_slug("!!!"), "source");
        assert_eq!(label_slug("   "), "");
    }

    #[test]
    fn unique_label_counts_up_and_never_doubles_the_suffix() {
        let mut taken = BTreeSet::new();
        taken.insert("x".to_string());

        assert_eq!(unique_label("X", &taken), "X 2");

        taken.insert("x 2".to_string());
        assert_eq!(unique_label("X", &taken), "X 3");
        // The clamp reserves the suffix, so a max-length label + " 2" still fits.
        let long = "y".repeat(LABEL_MAX);
        let clamped = unique_label(&long, &BTreeSet::new());
        assert_eq!(clamped.chars().count(), LABEL_MAX - 4);
    }

    #[test]
    fn connection_id_never_mints_local_for_another_kind() {
        assert_eq!(
            connection_id_for_label("This device", ConnectionKind::Local, &BTreeSet::new()),
            "local"
        );
        assert_ne!(
            connection_id_for_label("Local", ConnectionKind::Remote, &BTreeSet::new()),
            LOCAL_CONNECTION_ID
        );
    }

    #[test]
    fn connection_id_suffixes_on_collision() {
        let mut taken = BTreeSet::new();
        taken.insert("studio-box".to_string());

        assert_eq!(
            connection_id_for_label("Studio Box", ConnectionKind::Remote, &taken),
            "studio-box-2"
        );
    }

    #[test]
    fn normalize_url_prepends_http_and_rejects_other_schemes() {
        assert_eq!(
            normalize_remote_base_url("100.64.0.1:9119").expect("scheme-less"),
            "http://100.64.0.1:9119"
        );
        assert_eq!(
            normalize_remote_base_url(" https://gw.example.com/ ").expect("https"),
            "https://gw.example.com"
        );
        assert!(normalize_remote_base_url("ftp://gw").is_err());
        assert!(normalize_remote_base_url("file:///etc/passwd").is_err());
        assert!(normalize_remote_base_url("   ").is_err());
    }

    #[test]
    fn header_allowlist_drops_transport_headers_and_reports_them() {
        let (kept, dropped) = normalize_remote_headers(vec![
            "CF-Access-Client-Id".to_string(),
            "Authorization".to_string(),
            "Sec-WebSocket-Key".to_string(),
            "cf-access-client-id".to_string(),
        ]);

        assert_eq!(kept, vec!["cf-access-client-id"]);
        assert!(dropped.contains(&"authorization".to_string()));
        assert!(dropped.contains(&"sec-websocket-key".to_string()));
    }

    #[test]
    fn save_rejects_the_reserved_id_for_another_kind() {
        let existing = Connection {
            id: LOCAL_CONNECTION_ID.to_string(),
            kind: ConnectionKind::Remote,
            ..remote("local", "Local", "http://gw", 0)
        };
        let input = ConnectionInput {
            id: Some(LOCAL_CONNECTION_ID.to_string()),
            kind: ConnectionKind::Remote,
            label: "Local".to_string(),
            url: Some("http://gw".to_string()),
            ..ConnectionInput::default()
        };

        let err = normalize_connection_input(
            &input,
            Some(&existing),
            0,
            &BTreeSet::new(),
            &BTreeSet::new(),
        )
        .expect_err("reserved id");

        assert_eq!(err.kind, ConnectionsErrorKind::ReservedId);
    }

    #[test]
    fn save_requires_a_label_and_refuses_a_duplicate_one() {
        let blank = ConnectionInput {
            kind: ConnectionKind::Remote,
            url: Some("http://gw".to_string()),
            ..ConnectionInput::default()
        };

        assert_eq!(
            normalize_connection_input(&blank, None, 0, &BTreeSet::new(), &BTreeSet::new())
                .expect_err("blank label")
                .kind,
            ConnectionsErrorKind::InvalidInput
        );

        let mut labels = BTreeSet::new();
        labels.insert("studio".to_string());

        let clash = ConnectionInput {
            kind: ConnectionKind::Remote,
            label: " STUDIO ".to_string(),
            url: Some("http://gw".to_string()),
            ..ConnectionInput::default()
        };

        assert_eq!(
            normalize_connection_input(&clash, None, 0, &BTreeSet::new(), &labels)
                .expect_err("duplicate label")
                .kind,
            ConnectionsErrorKind::DuplicateLabel
        );
    }

    #[test]
    fn duplicate_url_is_rejected_across_remote_and_cloud() {
        let mut registry = Registry {
            connections: vec![remote("a", "A", "http://gw.example.com", 0)],
            ..Registry::default()
        };

        let cloud = Connection {
            id: "b".to_string(),
            kind: ConnectionKind::Cloud,
            ..remote("b", "B", "http://gw.example.com", 1)
        };

        assert_eq!(
            merge_connection_input(&mut registry, cloud)
                .expect_err("duplicate target")
                .kind,
            ConnectionsErrorKind::DuplicateTarget
        );
    }

    #[test]
    fn duplicate_ssh_target_is_rejected_on_host_port_and_profile() {
        let one = ConnectionInput {
            kind: ConnectionKind::Ssh,
            label: "One".to_string(),
            host: Some("me@box:2222".to_string()),
            remote_profile: Some("work".to_string()),
            ..ConnectionInput::default()
        };
        let (first, _) =
            normalize_connection_input(&one, None, 0, &BTreeSet::new(), &BTreeSet::new())
                .expect("first");

        assert_eq!(first.user.as_deref(), Some("me"));
        assert_eq!(first.host.as_deref(), Some("box"));
        assert_eq!(first.port, Some(2222));

        let mut registry = Registry {
            connections: vec![first.clone()],
            ..Registry::default()
        };

        let mut twin = first.clone();
        twin.id = "two".to_string();
        twin.label = "Two".to_string();

        assert_eq!(
            merge_connection_input(&mut registry, twin.clone())
                .expect_err("duplicate ssh")
                .kind,
            ConnectionsErrorKind::DuplicateTarget
        );

        // A different remote profile on the same host is a different backend.
        twin.remote_profile = Some("home".to_string());
        assert!(merge_connection_input(&mut registry, twin).is_ok());
    }

    #[test]
    fn merge_preserves_fields_the_editor_does_not_carry() {
        let mut stored = remote("a", "A", "http://gw", 0);
        stored.org = Some("acme".to_string());

        let input = ConnectionInput {
            id: Some("a".to_string()),
            kind: ConnectionKind::Remote,
            label: "A renamed".to_string(),
            url: Some("http://gw".to_string()),
            ..ConnectionInput::default()
        };

        let (merged, _) = normalize_connection_input(
            &input,
            Some(&stored),
            0,
            &BTreeSet::new(),
            &BTreeSet::new(),
        )
        .expect("merge");

        assert_eq!(merged.org.as_deref(), Some("acme"));
        assert_eq!(merged.order, 0);
    }

    #[test]
    fn label_only_edits_do_not_recycle_but_dial_edits_do() {
        let before = remote("a", "A", "http://gw", 0);
        let mut renamed = before.clone();
        renamed.label = "Renamed".to_string();

        assert!(!dial_fields_changed(&before, &renamed));

        let mut moved = before.clone();
        moved.url = Some("http://other".to_string());
        assert!(dial_fields_changed(&before, &moved));

        let mut reauthed = before.clone();
        reauthed.auth_mode = Some(AuthMode::Token);
        assert!(dial_fields_changed(&before, &reauthed));

        let mut headered = before.clone();
        headered.header_names = vec!["cf-access-client-id".to_string()];
        assert!(dial_fields_changed(&before, &headered));
    }

    #[test]
    fn normalize_degrades_junk_and_reports_it() {
        let mut registry = Registry {
            version: 99,
            primary: "gone".to_string(),
            launch_mode: LaunchMode::Primary,
            last_used: "also-gone".to_string(),
            legacy_id: None,
            connections: vec![
                remote("a", "Studio", "http://a", 7),
                remote("b", " studio ", "http://b", 9),
                remote("", "Nameless", "http://c", 3),
            ],
        };

        let degraded = normalize_registry(&mut registry, true).expect("degraded");

        assert!(!degraded.is_empty());
        assert_eq!(registry.version, REGISTRY_VERSION);
        // The empty id is dropped; the duplicate label is renamed, not dropped.
        assert_eq!(registry.connections.len(), 2);
        assert_eq!(registry.connections[1].label, "studio 2");
        assert_eq!(registry.connections[0].order, 0);
        assert_eq!(registry.connections[1].order, 1);
        assert_eq!(registry.primary, "a");
        assert_eq!(registry.last_used, "a");
    }

    #[test]
    fn normalize_keeps_at_most_one_local_and_drops_it_where_unsupported() {
        let mut registry = Registry {
            connections: vec![local_connection(), local_connection()],
            ..Registry::default()
        };

        assert!(normalize_registry(&mut registry, true).is_some());
        assert_eq!(registry.connections.len(), 1);

        let mut phone = Registry {
            connections: vec![local_connection(), remote("a", "A", "http://a", 1)],
            primary: LOCAL_CONNECTION_ID.to_string(),
            ..Registry::default()
        };

        assert_eq!(
            normalize_registry(&mut phone, false).as_deref(),
            Some("local-unsupported")
        );
        assert_eq!(phone.connections.len(), 1);
        assert_eq!(phone.primary, "a");
    }

    #[test]
    fn normalize_round_trips_a_valid_registry_unchanged() {
        let mut registry = Registry {
            version: REGISTRY_VERSION,
            primary: "a".to_string(),
            launch_mode: LaunchMode::Primary,
            last_used: "a".to_string(),
            legacy_id: Some(LOCAL_CONNECTION_ID.to_string()),
            connections: vec![local_connection(), remote("a", "A", "http://a", 1)],
        };
        let before = registry.clone();

        assert_eq!(normalize_registry(&mut registry, true), None);
        assert_eq!(registry, before);
    }

    #[test]
    fn migration_mints_one_entry_that_is_both_primary_and_last_used() {
        let target = serde_json::json!({ "mode": "remote", "url": "gw.example.com:9119" });
        let registry = migrate_from_v1_target(Some(&target), true);

        assert_eq!(registry.primary, registry.last_used);
        let migrated = registry
            .connections
            .iter()
            .find(|row| row.id == registry.primary)
            .expect("migrated row");
        assert_eq!(migrated.kind, ConnectionKind::Remote);
        assert_eq!(migrated.url.as_deref(), Some("http://gw.example.com:9119"));
        assert_eq!(migrated.label, "gw.example.com");

        let ssh = serde_json::json!({
            "mode": "ssh",
            "profile": "work",
            "ssh": { "host": "box", "user": "me", "port": 2222 }
        });
        let registry = migrate_from_v1_target(Some(&ssh), true);
        let migrated = registry
            .connections
            .iter()
            .find(|row| row.id == registry.primary)
            .expect("ssh row");
        assert_eq!(migrated.kind, ConnectionKind::Ssh);
        assert_eq!(migrated.label, "me@box");
        assert_eq!(migrated.port, Some(2222));
        assert_eq!(migrated.remote_profile.as_deref(), Some("work"));

        let cloud = serde_json::json!({
            "mode": "cloud",
            "cloudBaseUrl": "https://agent.hermes.cloud",
            "cloudAgentName": "Nimbus"
        });
        let registry = migrate_from_v1_target(Some(&cloud), true);
        assert_eq!(
            registry
                .connections
                .iter()
                .find(|row| row.id == registry.primary)
                .expect("cloud row")
                .label,
            "Nimbus"
        );

        let local = migrate_from_v1_target(Some(&serde_json::json!({ "mode": "local" })), true);
        assert_eq!(local.primary, LOCAL_CONNECTION_ID);

        // No saved target at all: a desktop still seeds its local row.
        let empty = migrate_from_v1_target(None, true);
        assert_eq!(empty.connections.len(), 1);
        assert_eq!(empty.primary, LOCAL_CONNECTION_ID);

        // …and a phone seeds nothing, because a `local` row would be undialable.
        let phone = migrate_from_v1_target(None, false);
        assert!(phone.connections.is_empty());
    }

    #[test]
    fn the_migrated_primary_keeps_the_bare_scope_key() {
        let ssh = serde_json::json!({ "mode": "ssh", "ssh": { "host": "box", "user": "me" } });
        let registry = migrate_from_v1_target(Some(&ssh), true);

        // The migrated entry is the PRIMARY, and the primary is dialled through
        // `backend_scope_key`, which collapses to the bare profile — which is
        // what `ssh_ownership_id` hashes. See `ssh/ownership.rs`'s own test.
        assert_eq!(
            backend_scope_key(Some(LOCAL_CONNECTION_ID), Some("default")),
            "default"
        );
        assert_ne!(
            backend_scope_key(Some(&registry.primary), Some("default")),
            "default",
            "a non-local migrated entry is only bare because it dials as the PRIMARY"
        );
    }

    #[test]
    fn the_legacy_owner_dials_bare_and_survives_a_primary_change() {
        let ssh = serde_json::json!({ "mode": "ssh", "ssh": { "host": "box", "user": "me" } });
        let mut registry = migrate_from_v1_target(Some(&ssh), false);
        let migrated = registry.primary.clone();

        assert_eq!(registry.legacy_id.as_deref(), Some(migrated.as_str()));
        assert_eq!(dial_connection_id(&registry, &migrated), None);
        assert_eq!(
            backend_scope_key(dial_connection_id(&registry, &migrated), Some("default")),
            "default"
        );

        // Promoting another gateway must NOT move the bare accounts: the old
        // primary still has a remote backend running under the bare ownership id.
        let mut second = remote("other", "Other", "http://other", 1);
        second.order = 1;
        registry.connections.push(second);
        registry.primary = "other".to_string();
        normalize_registry(&mut registry, false);

        assert_eq!(registry.legacy_id.as_deref(), Some(migrated.as_str()));
        assert_eq!(dial_connection_id(&registry, "other"), Some("other"));
        assert_eq!(
            backend_scope_key(dial_connection_id(&registry, "other"), Some("default")),
            "conn:other::default"
        );
    }

    #[test]
    fn removing_the_legacy_owner_does_not_hand_its_accounts_to_someone_else() {
        let mut registry = Registry {
            primary: "a".to_string(),
            last_used: "a".to_string(),
            legacy_id: Some("gone".to_string()),
            connections: vec![remote("a", "A", "http://a", 0)],
            ..Registry::default()
        };

        normalize_registry(&mut registry, false);

        assert_eq!(registry.legacy_id, None);
        assert_eq!(dial_connection_id(&registry, "a"), Some("a"));
    }

    #[test]
    fn update_eligibility_excludes_cloud_only() {
        assert!(!update_eligibility(ConnectionKind::Cloud).eligible);
        assert_eq!(
            update_eligibility(ConnectionKind::Cloud).reason.as_deref(),
            Some("cloud-managed")
        );
        assert!(update_eligibility(ConnectionKind::Local).eligible);
        assert!(update_eligibility(ConnectionKind::Remote).eligible);
        assert!(update_eligibility(ConnectionKind::Ssh).eligible);
    }

    #[test]
    fn unique_profiles_keep_bare_handles() {
        let roster = build_agent_roster(
            &[
                source(
                    "a",
                    "Studio",
                    ConnectionKind::Remote,
                    0,
                    Some(&["default", "work"]),
                    Some("i1"),
                ),
                source(
                    "b",
                    "Laptop",
                    ConnectionKind::Ssh,
                    1,
                    Some(&["home"]),
                    Some("i2"),
                ),
            ],
            None,
        );

        assert_eq!(roster.agents.len(), 3);
        assert!(roster
            .agents
            .iter()
            .all(|agent| agent.handle == agent.profile));
    }

    #[test]
    fn duplicated_profiles_across_boxes_get_device_handles() {
        let roster = build_agent_roster(
            &[
                source(
                    "a",
                    "Studio",
                    ConnectionKind::Remote,
                    0,
                    Some(&["default"]),
                    Some("i1"),
                ),
                source(
                    "b",
                    "Laptop",
                    ConnectionKind::Ssh,
                    1,
                    Some(&["default"]),
                    Some("i2"),
                ),
            ],
            None,
        );

        assert_eq!(roster.agents.len(), 2);
        assert!(roster
            .agents
            .iter()
            .any(|agent| agent.handle == "default-studio"));
        assert!(roster
            .agents
            .iter()
            .any(|agent| agent.handle == "default-laptop"));
    }

    #[test]
    fn two_connections_with_one_install_id_collapse_and_keep_the_bare_handle() {
        let roster = build_agent_roster(
            &[
                source(
                    "host",
                    "By hostname",
                    ConnectionKind::Remote,
                    0,
                    Some(&["default"]),
                    Some("same"),
                ),
                source(
                    "ip",
                    "By Tailscale IP",
                    ConnectionKind::Remote,
                    1,
                    Some(&["default"]),
                    Some("same"),
                ),
            ],
            None,
        );

        assert_eq!(roster.agents.len(), 1);
        // The whole reason the collapse runs FIRST: this profile only looked
        // duplicated, so it keeps its bare name.
        assert_eq!(roster.agents[0].handle, "default");
        assert_eq!(roster.agents[0].connection_id, "host");
    }

    #[test]
    fn a_third_same_box_connection_folds_too() {
        let roster = build_agent_roster(
            &[
                source(
                    "a",
                    "A",
                    ConnectionKind::Remote,
                    0,
                    Some(&["default"]),
                    Some("same"),
                ),
                source(
                    "b",
                    "B",
                    ConnectionKind::Remote,
                    1,
                    Some(&["default"]),
                    Some("same"),
                ),
                source(
                    "c",
                    "C",
                    ConnectionKind::Remote,
                    2,
                    Some(&["default"]),
                    Some("same"),
                ),
            ],
            None,
        );

        assert_eq!(roster.agents.len(), 1);
    }

    #[test]
    fn the_collapse_prefers_the_active_connection_then_kind_then_order() {
        let sources = [
            source(
                "remote",
                "Remote",
                ConnectionKind::Remote,
                0,
                Some(&["default"]),
                Some("same"),
            ),
            source(
                "ssh",
                "Ssh",
                ConnectionKind::Ssh,
                1,
                Some(&["default"]),
                Some("same"),
            ),
        ];

        assert_eq!(
            build_agent_roster(&sources, Some("remote")).agents[0].connection_id,
            "remote"
        );
        // With no active connection the kind priority decides: ssh outranks remote.
        assert_eq!(
            build_agent_roster(&sources, None).agents[0].connection_id,
            "ssh"
        );
    }

    #[test]
    fn a_missing_install_id_bypasses_the_collapse() {
        let roster = build_agent_roster(
            &[
                source(
                    "a",
                    "A",
                    ConnectionKind::Remote,
                    0,
                    Some(&["default"]),
                    None,
                ),
                source(
                    "b",
                    "B",
                    ConnectionKind::Remote,
                    1,
                    Some(&["default"]),
                    None,
                ),
            ],
            None,
        );

        // Two unidentified backends stay two agents — an older gateway keeps
        // today's behaviour rather than folding into every other one.
        assert_eq!(roster.agents.len(), 2);
    }

    #[test]
    fn an_unreachable_source_contributes_nothing_and_cannot_fake_a_duplicate() {
        let mut dead = source("dead", "Dead", ConnectionKind::Remote, 1, None, None);
        dead.error = Some("unreachable".to_string());

        let roster = build_agent_roster(
            &[
                source(
                    "a",
                    "Studio",
                    ConnectionKind::Remote,
                    0,
                    Some(&["default"]),
                    Some("i1"),
                ),
                dead,
            ],
            None,
        );

        assert_eq!(roster.agents.len(), 1);
        assert_eq!(roster.agents[0].handle, "default");
        assert_eq!(roster.sources.len(), 2);
        assert!(roster
            .sources
            .iter()
            .any(|row| !row.ok && row.error.is_some()));
    }

    #[test]
    fn duplicate_profiles_from_one_connection_remain_one_agent() {
        let roster = build_agent_roster(
            &[source(
                "a",
                "A",
                ConnectionKind::Remote,
                0,
                Some(&["work", "work"]),
                Some("i1"),
            )],
            None,
        );

        assert_eq!(roster.agents.len(), 1);
    }
}
