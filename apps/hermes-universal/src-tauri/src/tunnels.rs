//! Per-connection tunnels (MJXHRM-592).
//!
//! A local or SSH connection is reachable while another connection is active.
//! Each live backend is a SLOT — an SSH scope's session + forward, or the one
//! local child — and a slot lives exactly as long as it has holders: the primary
//! (the active connection's own dial) and any number of `(window label, lease
//! id)` leases. JS only ever sees a loopback base URL, an instance key and a
//! generation; the token is attached in Rust (`TransportState::set_tunnel_auth`).
//!
//! Two layers, on purpose:
//!
//!  * `SlotBook` is pure. Every lifecycle decision — dial, join, reuse,
//!    teardown, redial — is a method returning an `Action`, so the whole
//!    refcount and reconnect policy is unit-tested with no runtime.
//!  * The runtime half turns actions into effects: single-flight waiters on a
//!    `watch` channel, the `tunnel://{id}/changed` and `/status` events, the
//!    backoff timer, and the actual dials in `ssh` and `local_backend`.
//!
//! The primary keeps redialling itself (`rebootstrapSsh`); Rust redials only a
//! slot the primary does not hold, and never with a prompt — a background tunnel
//! that needs a person stops and reports a terminal failure instead.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Webview, Wry};
use tokio::sync::watch;

use crate::ssh::error::SshErrorKind;

/// The one local child's slot key.
pub const LOCAL_SLOT: &str = "local";
/// The local child's instance key. There is only ever one per install.
pub const LOCAL_INSTANCE_KEY: &str = "local";

pub const BACKOFF_BASE: Duration = Duration::from_secs(1);
pub const BACKOFF_CAP: Duration = Duration::from_secs(30);
/// Full jitter can draw zero; a floor keeps a dead host from being hammered.
const BACKOFF_FLOOR: Duration = Duration::from_millis(250);

// --------------------------------------------------------------------------
// The pure book
// --------------------------------------------------------------------------

/// A lease on a slot, owned by one window.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Holder {
    pub window: String,
    pub lease: String,
}

impl Holder {
    pub fn new(window: impl Into<String>, lease: impl Into<String>) -> Self {
        Self {
            window: window.into(),
            lease: lease.into(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SlotKind {
    Ssh,
    Local,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    /// A dial is in flight.
    Connecting,
    Ready,
    /// Waiting on the backoff timer; no dial in flight.
    Retrying,
    Failed,
}

/// Why a dial failed, as far as the reconnect loop cares.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum FailureKind {
    /// The credential store is locked; unlocking needs a person.
    Locked,
    /// A passphrase, password or key the tunnel does not hold.
    CredentialsNeeded,
    HostKeyChanged,
    Cancelled,
    HermesNotFound,
    UpdateRequired,
    UnsupportedPlatform,
    /// Not a local or SSH connection, or no longer registered.
    Unavailable,
    /// Worth retrying on its own.
    Transient,
}

impl FailureKind {
    /// Terminal failures stop the loop: retrying them either cannot succeed
    /// without a person or burns the server's auth attempts.
    pub fn is_terminal(self) -> bool {
        !matches!(self, Self::Transient)
    }

    pub fn from_ssh(kind: SshErrorKind) -> Self {
        match kind {
            SshErrorKind::AuthFailed => Self::CredentialsNeeded,
            SshErrorKind::HostKeyChanged => Self::HostKeyChanged,
            SshErrorKind::Cancelled => Self::Cancelled,
            SshErrorKind::HermesNotFound => Self::HermesNotFound,
            SshErrorKind::UpdateRequired => Self::UpdateRequired,
            SshErrorKind::UnsupportedPlatform => Self::UnsupportedPlatform,
            SshErrorKind::Unreachable
            | SshErrorKind::Timeout
            | SshErrorKind::TransientTransportError
            | SshErrorKind::AuthenticatedStale
            | SshErrorKind::Superseded
            | SshErrorKind::Unknown => Self::Transient,
        }
    }
}

/// What a slot is, fixed when it is created.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SlotSpec {
    pub connection_id: String,
    pub kind: SlotKind,
    pub instance_key: String,
    /// The profile a (re)dial launches the backend as. The scope already
    /// encodes it for SSH; for local it is the child's launch profile.
    pub profile: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Slot {
    pub spec: SlotSpec,
    pub holders: HashSet<Holder>,
    pub primary: bool,
    pub phase: Phase,
    /// Bumped on every successful (re)establish.
    pub generation: u64,
    /// The redial attempt the backoff timer is armed for.
    pub attempt: u32,
    pub base_url: Option<String>,
    pub failure: Option<FailureKind>,
}

impl Slot {
    fn new(spec: SlotSpec) -> Self {
        Self {
            spec,
            holders: HashSet::new(),
            primary: false,
            phase: Phase::Connecting,
            generation: 0,
            attempt: 0,
            base_url: None,
            failure: None,
        }
    }

    fn unheld(&self) -> bool {
        !self.primary && self.holders.is_empty()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    None,
    /// Start a dial; the caller owns it.
    Dial,
    /// A dial is in flight; wait for it.
    Join,
    /// Live and ready; use it as is.
    Reuse,
    /// A dial landed.
    Ready {
        generation: u64,
    },
    /// Arm the backoff timer for this attempt.
    Redial {
        attempt: u32,
    },
    /// The slot is gone; drop its resources.
    Teardown,
}

#[derive(Debug, Default)]
pub struct SlotBook {
    slots: BTreeMap<String, Slot>,
}

impl SlotBook {
    pub fn slot(&self, key: &str) -> Option<&Slot> {
        self.slots.get(key)
    }

    pub fn slots_for(&self, connection_id: &str) -> Vec<String> {
        self.slots
            .iter()
            .filter(|(_, slot)| slot.spec.connection_id == connection_id)
            .map(|(key, _)| key.clone())
            .collect()
    }

    /// The slot a connection is reached through: the primary's first, so a
    /// lease on the active connection never opens a second backend beside it.
    pub fn key_for(&self, connection_id: &str) -> Option<String> {
        let mut candidates = self
            .slots
            .iter()
            .filter(|(_, slot)| slot.spec.connection_id == connection_id);

        let first = candidates.next()?;

        Some(
            std::iter::once(first)
                .chain(candidates)
                .find(|(_, slot)| slot.primary)
                .unwrap_or(first)
                .0
                .clone(),
        )
    }

    /// A lease joins the connection's live slot, or creates one at `key`.
    pub fn acquire(&mut self, key: &str, spec: SlotSpec, holder: Holder) -> (String, Action) {
        let key = self
            .key_for(&spec.connection_id)
            .unwrap_or_else(|| key.to_string());

        if let Some(slot) = self.slots.get_mut(&key) {
            slot.holders.insert(holder);

            let action = match slot.phase {
                Phase::Ready => Action::Reuse,
                Phase::Connecting => Action::Join,
                // A person (or a request) asking again is the retry.
                Phase::Retrying | Phase::Failed => {
                    slot.phase = Phase::Connecting;
                    Action::Dial
                }
            };

            return (key, action);
        }

        let mut slot = Slot::new(spec);
        slot.holders.insert(holder);
        self.slots.insert(key.clone(), slot);

        (key, Action::Dial)
    }

    /// The active connection's own dial. `alive` is the caller's liveness read of
    /// what the slot holds: a ready slot whose session died is redialled, never
    /// reused — and never closed while it is still serving someone.
    pub fn hold_primary(&mut self, key: &str, spec: SlotSpec, alive: bool) -> Action {
        if let Some(slot) = self.slots.get_mut(key) {
            slot.primary = true;

            return match slot.phase {
                Phase::Ready if alive => Action::Reuse,
                Phase::Connecting => Action::Join,
                _ => {
                    slot.phase = Phase::Connecting;
                    Action::Dial
                }
            };
        }

        let mut slot = Slot::new(spec);
        slot.primary = true;
        self.slots.insert(key.to_string(), slot);

        Action::Dial
    }

    /// Leaving the active connection. `None` when there was no slot at all.
    pub fn release_primary(&mut self, key: &str) -> Option<Action> {
        let slot = self.slots.get_mut(key)?;

        slot.primary = false;

        if slot.holders.is_empty() {
            self.slots.remove(key);

            return Some(Action::Teardown);
        }

        // The primary owned the retries while it held the slot. Hand a dead,
        // retryable slot to the Rust loop now that leases are all that is left.
        if slot.phase == Phase::Failed && !slot.failure.is_some_and(FailureKind::is_terminal) {
            slot.attempt += 1;
            slot.phase = Phase::Retrying;

            return Some(Action::Redial {
                attempt: slot.attempt,
            });
        }

        Some(Action::None)
    }

    fn drop_holders(&mut self, keep: impl Fn(&str, &Holder) -> bool) -> Vec<(String, Action)> {
        let keys: Vec<String> = self
            .slots
            .iter()
            .filter(|(_, slot)| {
                slot.holders
                    .iter()
                    .any(|holder| !keep(&slot.spec.connection_id, holder))
            })
            .map(|(key, _)| key.clone())
            .collect();

        keys.into_iter()
            .map(|key| {
                let slot = self.slots.get_mut(&key).expect("key was just listed");
                let connection_id = slot.spec.connection_id.clone();

                slot.holders.retain(|holder| keep(&connection_id, holder));

                if slot.unheld() {
                    self.slots.remove(&key);

                    (key, Action::Teardown)
                } else {
                    (key, Action::None)
                }
            })
            .collect()
    }

    pub fn release(&mut self, connection_id: &str, holder: &Holder) -> Vec<(String, Action)> {
        self.drop_holders(|id, held| id != connection_id || held != holder)
    }

    /// A destroyed window runs no JS teardown, so its leases go here.
    pub fn reap_window(&mut self, label: &str) -> Vec<(String, Action)> {
        self.drop_holders(|_, held| held.window != label)
    }

    /// The backend behind a ready slot died.
    pub fn on_dead(&mut self, key: &str) -> Action {
        let Some(slot) = self.slots.get_mut(key) else {
            return Action::None;
        };

        if slot.phase != Phase::Ready {
            return Action::None;
        }

        slot.failure = Some(FailureKind::Transient);

        // The primary's own watchdog re-bootstraps it.
        if slot.primary {
            slot.phase = Phase::Failed;

            return Action::None;
        }

        if slot.holders.is_empty() {
            self.slots.remove(key);

            return Action::Teardown;
        }

        slot.attempt += 1;
        slot.phase = Phase::Retrying;

        Action::Redial {
            attempt: slot.attempt,
        }
    }

    pub fn on_dial_result(&mut self, key: &str, result: Result<&str, FailureKind>) -> Action {
        let Some(slot) = self.slots.get_mut(key) else {
            // Everyone left mid-dial: whatever it installed goes.
            return if result.is_ok() {
                Action::Teardown
            } else {
                Action::None
            };
        };

        match result {
            Ok(base_url) => {
                if slot.unheld() {
                    self.slots.remove(key);

                    return Action::Teardown;
                }

                slot.phase = Phase::Ready;
                slot.generation += 1;
                slot.attempt = 0;
                slot.failure = None;
                slot.base_url = Some(base_url.to_string());

                Action::Ready {
                    generation: slot.generation,
                }
            }

            Err(kind) => {
                slot.failure = Some(kind);

                // A lease whose FIRST dial fails gets the error, not a retry
                // loop it never saw succeed.
                if slot.unheld() || (slot.generation == 0 && !slot.primary) {
                    self.slots.remove(key);

                    return Action::Teardown;
                }

                if slot.primary || kind.is_terminal() {
                    slot.phase = Phase::Failed;

                    return Action::None;
                }

                slot.attempt += 1;
                slot.phase = Phase::Retrying;

                Action::Redial {
                    attempt: slot.attempt,
                }
            }
        }
    }

    /// The backoff timer fired. False when the attempt is stale or unwanted.
    pub fn begin_redial(&mut self, key: &str, attempt: u32) -> bool {
        let Some(slot) = self.slots.get_mut(key) else {
            return false;
        };

        if slot.phase != Phase::Retrying
            || slot.attempt != attempt
            || slot.primary
            || slot.holders.is_empty()
        {
            return false;
        }

        slot.phase = Phase::Connecting;

        true
    }

    /// "Restart as <profile>": the explicit respawn, keeping every holder.
    pub fn restart(&mut self, key: &str, profile: Option<String>) -> Action {
        let Some(slot) = self.slots.get_mut(key) else {
            return Action::None;
        };

        slot.phase = Phase::Connecting;
        slot.spec.profile = profile;

        Action::Dial
    }

    /// A connection was edited (dial fields) or removed. Its leases end; a slot
    /// the primary still holds stays until the primary lets it go.
    pub fn drop_connection(&mut self, connection_id: &str) -> Vec<(String, Action)> {
        self.drop_holders(|id, _| id != connection_id)
    }

    pub fn remove(&mut self, key: &str) -> Option<Slot> {
        self.slots.remove(key)
    }

    pub fn drain(&mut self) -> Vec<(String, Slot)> {
        std::mem::take(&mut self.slots).into_iter().collect()
    }
}

/// Full-jitter exponential backoff, capped at 30 s.
pub fn backoff_delay(attempt: u32, unit: f64) -> Duration {
    let exponent = attempt.saturating_sub(1).min(16);
    let ceiling = BACKOFF_BASE
        .saturating_mul(1u32 << exponent)
        .min(BACKOFF_CAP);

    ceiling
        .mul_f64(unit.clamp(0.0, 1.0))
        .max(BACKOFF_FLOOR)
        .min(BACKOFF_CAP)
}

fn random_unit() -> f64 {
    let mut buf = [0u8; 8];
    getrandom::getrandom(&mut buf).ok();

    (u64::from_le_bytes(buf) >> 11) as f64 / (1u64 << 53) as f64
}

/// `ssh:<user>@<resolved host>:<port>` — stable across re-tunnels, profile
/// changes and restarts, and different when the row's host, user or port is.
pub fn ssh_instance_key(user: &str, host: &str, port: u16) -> String {
    format!(
        "ssh:{}@{}:{port}",
        user.trim().to_lowercase(),
        host.trim().to_lowercase()
    )
}

// --------------------------------------------------------------------------
// Runtime
// --------------------------------------------------------------------------

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TunnelDescriptor {
    pub connection_id: String,
    pub base_url: String,
    pub instance_key: String,
    pub generation: u64,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TunnelError {
    pub kind: FailureKind,
    pub message: String,
    pub terminal: bool,
}

impl TunnelError {
    pub fn new(kind: FailureKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            terminal: kind.is_terminal(),
        }
    }

    pub fn from_ssh(error: &crate::ssh::error::SshError) -> Self {
        Self::new(FailureKind::from_ssh(error.kind), error.message.clone())
    }
}

#[derive(Debug, Clone)]
pub enum Outcome {
    Pending,
    Ready(TunnelDescriptor),
    Failed(TunnelError),
}

#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum StatusPhase {
    Connecting,
    Ready,
    Retrying,
    Failed,
    /// The slot is gone.
    Closed,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TunnelStatus {
    pub connection_id: String,
    pub phase: StatusPhase,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_kind: Option<FailureKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    pub terminal: bool,
    pub generation: u64,
    pub instance_key: String,
}

#[derive(Default)]
pub struct TunnelState {
    inner: std::sync::Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    book: SlotBook,
    signals: HashMap<String, watch::Sender<Outcome>>,
    /// The install's SSH identity, remembered for Rust-driven redials.
    installation_id: Option<String>,
}

enum Effect {
    Teardown { key: String, kind: SlotKind },
    Redial { key: String, attempt: u32 },
}

/// The result of the primary asking for its slot.
pub(crate) enum Hold {
    Reuse,
    Join(watch::Receiver<Outcome>),
    Dial,
}

fn locked<T>(app: &AppHandle, change: impl FnOnce(&mut Inner) -> T) -> T {
    let state = app.state::<TunnelState>();
    let mut inner = state
        .inner
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    change(&mut inner)
}

fn descriptor(slot: &Slot) -> Option<TunnelDescriptor> {
    Some(TunnelDescriptor {
        connection_id: slot.spec.connection_id.clone(),
        base_url: slot.base_url.clone()?,
        instance_key: slot.spec.instance_key.clone(),
        generation: slot.generation,
    })
}

fn status_of(slot: &Slot, phase: StatusPhase, message: Option<String>) -> TunnelStatus {
    let failed = matches!(phase, StatusPhase::Failed | StatusPhase::Retrying);

    TunnelStatus {
        connection_id: slot.spec.connection_id.clone(),
        phase,
        error_kind: slot.failure.filter(|_| failed || message.is_some()),
        terminal: phase == StatusPhase::Failed
            && slot.failure.is_some_and(FailureKind::is_terminal),
        message,
        generation: slot.generation,
        instance_key: slot.spec.instance_key.clone(),
    }
}

fn phase_of(slot: &Slot) -> StatusPhase {
    match slot.phase {
        Phase::Connecting => StatusPhase::Connecting,
        Phase::Ready => StatusPhase::Ready,
        Phase::Retrying => StatusPhase::Retrying,
        Phase::Failed => StatusPhase::Failed,
    }
}

fn emit_status(app: &AppHandle, status: &TunnelStatus) {
    let _ = app.emit(&format!("tunnel://{}/status", status.connection_id), status);
}

fn signal(inner: &mut Inner, key: &str) -> watch::Sender<Outcome> {
    inner
        .signals
        .entry(key.to_string())
        .or_insert_with(|| watch::channel(Outcome::Pending).0)
        .clone()
}

/// Mark a dial as begun: waiters see `Pending`, the UI sees `connecting`.
fn begin(app: &AppHandle, inner: &mut Inner, key: &str) -> watch::Receiver<Outcome> {
    let tx = signal(inner, key);

    tx.send_replace(Outcome::Pending);

    if let Some(slot) = inner.book.slot(key) {
        emit_status(app, &status_of(slot, StatusPhase::Connecting, None));
    }

    tx.subscribe()
}

/// A slot left the book: fail its waiters, say so, and schedule its resources.
fn closed(
    app: &AppHandle,
    inner: &mut Inner,
    key: &str,
    before: &Slot,
    error: Option<&TunnelError>,
) -> Effect {
    if let Some(tx) = inner.signals.remove(key) {
        tx.send_replace(Outcome::Failed(error.cloned().unwrap_or_else(|| {
            TunnelError::new(FailureKind::Transient, "the tunnel was closed")
        })));
    }

    let mut status = status_of(before, StatusPhase::Closed, None);

    if let Some(error) = error {
        status.phase = StatusPhase::Failed;
        status.error_kind = Some(error.kind);
        status.message = Some(error.message.clone());
        status.terminal = error.terminal;
    }

    emit_status(app, &status);

    Effect::Teardown {
        key: key.to_string(),
        kind: before.spec.kind,
    }
}

async fn apply(app: &AppHandle, effects: Vec<Effect>) {
    for effect in effects {
        match effect {
            Effect::Teardown { key, kind } => teardown(app, &key, kind).await,
            Effect::Redial { key, attempt } => schedule_redial(app.clone(), key, attempt),
        }
    }
}

fn apply_detached(app: &AppHandle, effects: Vec<Effect>) {
    if effects.is_empty() {
        return;
    }

    let app = app.clone();

    tauri::async_runtime::spawn(async move { apply(&app, effects).await });
}

async fn teardown(app: &AppHandle, key: &str, kind: SlotKind) {
    log::info!("[tunnel] tearing down {key:?}");

    match kind {
        SlotKind::Ssh => crate::ssh::teardown_scope(app, key).await,
        SlotKind::Local => crate::local_backend::kill_child(app).await,
    }
}

fn book_effects(
    app: &AppHandle,
    inner: &mut Inner,
    before: Vec<(String, Slot)>,
    actions: Vec<(String, Action)>,
) -> Vec<Effect> {
    let before: HashMap<String, Slot> = before.into_iter().collect();

    actions
        .into_iter()
        .filter_map(|(key, action)| match action {
            Action::Teardown => before
                .get(&key)
                .map(|slot| closed(app, inner, &key, slot, None)),
            _ => None,
        })
        .collect()
}

pub(crate) fn hold_primary(app: &AppHandle, key: &str, spec: SlotSpec, alive: bool) -> Hold {
    locked(app, |inner| {
        match inner.book.hold_primary(key, spec, alive) {
            Action::Reuse => Hold::Reuse,
            Action::Join => Hold::Join(signal(inner, key).subscribe()),
            _ => {
                begin(app, inner, key);
                Hold::Dial
            }
        }
    })
}

/// Wait for a single-flight dial to settle.
pub(crate) async fn wait(
    mut rx: watch::Receiver<Outcome>,
) -> Result<TunnelDescriptor, TunnelError> {
    loop {
        match &*rx.borrow_and_update() {
            Outcome::Ready(descriptor) => return Ok(descriptor.clone()),
            Outcome::Failed(error) => return Err(error.clone()),
            Outcome::Pending => {}
        }

        if rx.changed().await.is_err() {
            return match &*rx.borrow() {
                Outcome::Ready(descriptor) => Ok(descriptor.clone()),
                Outcome::Failed(error) => Err(error.clone()),
                Outcome::Pending => Err(TunnelError::new(
                    FailureKind::Transient,
                    "the tunnel was closed",
                )),
            };
        }
    }
}

/// Record a dial's outcome and act on it.
pub(crate) fn finish_dial(app: &AppHandle, key: &str, result: Result<String, TunnelError>) {
    let effects = locked(app, |inner| {
        let before = inner.book.slot(key).cloned();
        let action = inner
            .book
            .on_dial_result(key, result.as_deref().map_err(|error| error.kind));

        match (action, &result) {
            (Action::Ready { .. }, _) => {
                let slot = inner.book.slot(key).expect("a ready slot exists").clone();

                if let Some(descriptor) = descriptor(&slot) {
                    log::info!(
                        "[tunnel] {} ready at generation {}",
                        slot.spec.connection_id,
                        slot.generation
                    );
                    signal(inner, key).send_replace(Outcome::Ready(descriptor.clone()));
                    let _ = app.emit(
                        &format!("tunnel://{}/changed", slot.spec.connection_id),
                        &descriptor,
                    );
                    emit_status(app, &status_of(&slot, StatusPhase::Ready, None));
                }

                vec![]
            }

            (Action::Redial { attempt }, Err(error)) => {
                signal(inner, key).send_replace(Outcome::Failed(error.clone()));

                if let Some(slot) = inner.book.slot(key) {
                    emit_status(
                        app,
                        &status_of(slot, StatusPhase::Retrying, Some(error.message.clone())),
                    );
                }

                vec![Effect::Redial {
                    key: key.to_string(),
                    attempt,
                }]
            }

            (Action::Teardown, _) => before
                .map(|slot| vec![closed(app, inner, key, &slot, result.as_ref().err())])
                .unwrap_or_else(|| {
                    // Nobody held the slot any more; drop what the dial built.
                    vec![Effect::Teardown {
                        key: key.to_string(),
                        kind: if key == LOCAL_SLOT {
                            SlotKind::Local
                        } else {
                            SlotKind::Ssh
                        },
                    }]
                }),

            (_, Err(error)) => {
                log::warn!("[tunnel] {key:?} failed: {}", error.message);
                signal(inner, key).send_replace(Outcome::Failed(error.clone()));

                if let Some(slot) = inner.book.slot(key) {
                    emit_status(
                        app,
                        &status_of(slot, phase_of(slot), Some(error.message.clone())),
                    );
                }

                vec![]
            }

            _ => vec![],
        }
    });

    apply_detached(app, effects);
}

fn schedule_redial(app: AppHandle, key: String, attempt: u32) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(backoff_delay(attempt, random_unit())).await;

        let plan = locked(&app, |inner| {
            if !inner.book.begin_redial(&key, attempt) {
                return None;
            }

            begin(&app, inner, &key);

            let spec = inner.book.slot(&key)?.spec.clone();

            Some((spec, inner.installation_id.clone()))
        });

        if let Some((spec, installation_id)) = plan {
            let result = dial(&app, &key, &spec, installation_id, false).await;

            finish_dial(&app, &key, result);
        }
    });
}

async fn dial(
    app: &AppHandle,
    key: &str,
    spec: &SlotSpec,
    installation_id: Option<String>,
    interactive: bool,
) -> Result<String, TunnelError> {
    match spec.kind {
        SlotKind::Ssh => {
            crate::ssh::dial_tunnel(
                app,
                key,
                &spec.connection_id,
                spec.profile.clone(),
                installation_id,
                interactive,
            )
            .await
        }
        SlotKind::Local => crate::local_backend::dial_tunnel(app, spec.profile.clone()).await,
    }
}

/// The backend behind a slot died (the SSH watchdog, the local child watcher).
pub(crate) fn on_dead(app: &AppHandle, key: &str) {
    let effects = locked(app, |inner| {
        let before = inner.book.slot(key).cloned();

        match inner.book.on_dead(key) {
            Action::Redial { attempt } => {
                if let Some(slot) = inner.book.slot(key) {
                    emit_status(app, &status_of(slot, StatusPhase::Retrying, None));
                }

                vec![Effect::Redial {
                    key: key.to_string(),
                    attempt,
                }]
            }
            Action::Teardown => before
                .map(|slot| vec![closed(app, inner, key, &slot, None)])
                .unwrap_or_default(),
            _ => {
                if let Some(slot) = inner.book.slot(key) {
                    emit_status(app, &status_of(slot, phase_of(slot), None));
                }

                vec![]
            }
        }
    });

    apply_detached(app, effects);
}

/// Leaving the active connection. False when the book had no slot for `key`,
/// so the caller can fall back to its pre-tunnel teardown.
pub(crate) async fn release_primary(app: &AppHandle, key: &str) -> bool {
    let (existed, effects) = locked(app, |inner| {
        let before = inner.book.slot(key).cloned();

        match inner.book.release_primary(key) {
            None => (false, vec![]),
            Some(Action::Teardown) => (
                true,
                before
                    .map(|slot| vec![closed(app, inner, key, &slot, None)])
                    .unwrap_or_default(),
            ),
            Some(Action::Redial { attempt }) => (
                true,
                vec![Effect::Redial {
                    key: key.to_string(),
                    attempt,
                }],
            ),
            Some(_) => (true, vec![]),
        }
    });

    apply(app, effects).await;

    existed
}

/// "Restart as <profile>": begin the respawn in place. False when there is no
/// slot, in which case the caller spawns through the primary path.
pub(crate) fn begin_restart(app: &AppHandle, key: &str, profile: Option<String>) -> bool {
    locked(app, |inner| match inner.book.restart(key, profile) {
        Action::Dial => {
            begin(app, inner, key);
            true
        }
        _ => false,
    })
}

/// Drop a slot regardless of its holders (a hard stop: quit, the tray).
pub(crate) fn remove_slot(app: &AppHandle, key: &str) {
    locked(app, |inner| {
        if let Some(slot) = inner.book.remove(key) {
            closed(app, inner, key, &slot, None);
        }
    });
}

/// Every slot key a connection currently has. For MJXHRM-528's drain, which is
/// its first caller.
#[allow(dead_code)]
pub(crate) fn slots_for(app: &AppHandle, connection_id: &str) -> Vec<String> {
    locked(app, |inner| inner.book.slots_for(connection_id))
}

/// A destroyed window's leases end with it.
pub fn reap_window(app: &AppHandle, label: &str) {
    let effects = locked(app, |inner| {
        let before: Vec<(String, Slot)> = inner
            .book
            .slots
            .iter()
            .map(|(key, slot)| (key.clone(), slot.clone()))
            .collect();
        let actions = inner.book.reap_window(label);

        book_effects(app, inner, before, actions)
    });

    apply_detached(app, effects);
}

/// A connection's dial fields were edited, or it was removed.
pub(crate) async fn drop_connection(app: &AppHandle, connection_id: &str) {
    let effects = locked(app, |inner| {
        let before: Vec<(String, Slot)> = inner
            .book
            .slots
            .iter()
            .map(|(key, slot)| (key.clone(), slot.clone()))
            .collect();
        let actions = inner.book.drop_connection(connection_id);

        book_effects(app, inner, before, actions)
    });

    apply(app, effects).await;
}

/// `RunEvent::Exit`: every tunnel goes, and the local child is killed whether
/// or not anything still holds it.
pub fn shutdown(app: &AppHandle) {
    let slots = locked(app, |inner| {
        inner.signals.clear();
        inner.book.drain()
    });

    let app = app.clone();

    tauri::async_runtime::block_on(async move {
        let work = async {
            for (key, slot) in slots {
                teardown(&app, &key, slot.spec.kind).await;
            }

            crate::local_backend::kill_child(&app).await;
        };

        // A session close sends a disconnect; a dead network must not hold the
        // process open.
        let _ = tokio::time::timeout(Duration::from_secs(3), work).await;
    });
}

// --------------------------------------------------------------------------
// Commands
// --------------------------------------------------------------------------

/// Where a registered local or SSH connection is dialled.
pub enum TunnelTarget {
    Local,
    Ssh {
        scope: String,
        profile: Option<String>,
        input: crate::ssh::target::SshTargetInput,
    },
}

/// Reach a local or SSH connection that may not be the active one.
#[tauri::command]
pub async fn tunnel_acquire(
    app: AppHandle,
    webview: Webview<Wry>,
    connection_id: String,
    lease_id: String,
    installation_id: Option<String>,
    interactive: bool,
) -> Result<TunnelDescriptor, TunnelError> {
    let target = crate::connections::tunnel_target(&app, &connection_id).ok_or_else(|| {
        TunnelError::new(
            FailureKind::Unavailable,
            "no local or SSH connection is registered under that id",
        )
    })?;

    let (key, spec) = match target {
        TunnelTarget::Local => {
            if !cfg!(desktop) {
                return Err(TunnelError::new(
                    FailureKind::UnsupportedPlatform,
                    "unsupported_platform",
                ));
            }

            (
                LOCAL_SLOT.to_string(),
                SlotSpec {
                    connection_id: connection_id.clone(),
                    kind: SlotKind::Local,
                    instance_key: LOCAL_INSTANCE_KEY.to_string(),
                    profile: None,
                },
            )
        }
        TunnelTarget::Ssh {
            scope,
            profile,
            input,
        } => {
            let instance_key =
                crate::ssh::instance_key_for(&input).map_err(|e| TunnelError::from_ssh(&e))?;

            (
                scope,
                SlotSpec {
                    connection_id: connection_id.clone(),
                    kind: SlotKind::Ssh,
                    instance_key,
                    profile,
                },
            )
        }
    };

    let holder = Holder::new(webview.window().label(), lease_id);

    let (key, spec, installation_id, next) = locked(&app, |inner| {
        if installation_id.is_some() {
            inner.installation_id = installation_id.clone();
        }

        let (key, action) = inner.book.acquire(&key, spec, holder);
        let slot = inner
            .book
            .slot(&key)
            .expect("an acquired slot exists")
            .clone();

        let next = match action {
            Action::Reuse => Err(descriptor(&slot)),
            Action::Dial => Ok((true, begin(&app, inner, &key))),
            _ => Ok((false, signal(inner, &key).subscribe())),
        };

        (key, slot.spec, inner.installation_id.clone(), next)
    });

    let (dials, rx) = match next {
        Err(Some(ready)) => return Ok(ready),
        Err(None) => {
            return Err(TunnelError::new(
                FailureKind::Transient,
                "the tunnel has no address",
            ))
        }
        Ok(pending) => pending,
    };

    if dials {
        let result = dial(&app, &key, &spec, installation_id, interactive).await;

        finish_dial(&app, &key, result);
    }

    wait(rx).await
}

#[tauri::command]
pub async fn tunnel_release(
    app: AppHandle,
    webview: Webview<Wry>,
    connection_id: String,
    lease_id: String,
) -> Result<(), TunnelError> {
    let holder = Holder::new(webview.window().label(), lease_id);

    let effects = locked(&app, |inner| {
        let before: Vec<(String, Slot)> = inner
            .book
            .slots
            .iter()
            .map(|(key, slot)| (key.clone(), slot.clone()))
            .collect();
        let actions = inner.book.release(&connection_id, &holder);

        book_effects(&app, inner, before, actions)
    });

    apply(&app, effects).await;

    Ok(())
}

#[tauri::command]
pub async fn tunnel_status(app: AppHandle, connection_id: String) -> Option<TunnelStatus> {
    locked(&app, |inner| {
        let key = inner.book.key_for(&connection_id)?;
        let slot = inner.book.slot(&key)?;

        Some(status_of(slot, phase_of(slot), None))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ssh(id: &str) -> SlotSpec {
        SlotSpec {
            connection_id: id.to_string(),
            kind: SlotKind::Ssh,
            instance_key: ssh_instance_key("deploy", "box", 22),
            profile: None,
        }
    }

    fn local() -> SlotSpec {
        SlotSpec {
            connection_id: "local".to_string(),
            kind: SlotKind::Local,
            instance_key: LOCAL_INSTANCE_KEY.to_string(),
            profile: Some("work".to_string()),
        }
    }

    fn main_lease(lease: &str) -> Holder {
        Holder::new("main", lease)
    }

    /// A slot that has been dialled once and is serving.
    fn ready(book: &mut SlotBook, key: &str) {
        assert!(matches!(
            book.on_dial_result(key, Ok("http://127.0.0.1:41000")),
            Action::Ready { .. }
        ));
    }

    #[test]
    fn r1_two_holders_share_one_dial_and_the_last_release_tears_down() {
        let mut book = SlotBook::default();

        let (key, first) = book.acquire("conn:a::default", ssh("a"), main_lease("l1"));
        let (joined, second) = book.acquire("conn:a::default", ssh("a"), main_lease("l2"));

        assert_eq!(first, Action::Dial);
        assert_eq!(second, Action::Join);
        assert_eq!(joined, key);

        ready(&mut book, &key);

        assert_eq!(
            book.release("a", &main_lease("l1")),
            vec![(key.clone(), Action::None)]
        );
        assert!(book.slot(&key).is_some());
        assert_eq!(
            book.release("a", &main_lease("l2")),
            vec![(key.clone(), Action::Teardown)]
        );
        assert!(book.slot(&key).is_none());
    }

    #[test]
    fn r2_the_primary_adopts_a_live_leased_slot_instead_of_replacing_it() {
        let mut book = SlotBook::default();
        let (key, _) = book.acquire("conn:a::default", ssh("a"), main_lease("l1"));

        ready(&mut book, &key);

        assert_eq!(book.hold_primary(&key, ssh("a"), true), Action::Reuse);
        assert_eq!(book.slot(&key).map(|slot| slot.generation), Some(1));
        // A dead session is redialled, but the slot and its lease survive it.
        assert_eq!(book.hold_primary(&key, ssh("a"), false), Action::Dial);
        assert!(book.slot(&key).is_some_and(|slot| slot.holders.len() == 1));
    }

    #[test]
    fn r3_releasing_the_primary_keeps_a_leased_slot() {
        let mut book = SlotBook::default();

        assert_eq!(
            book.hold_primary("conn:a::default", ssh("a"), false),
            Action::Dial
        );
        ready(&mut book, "conn:a::default");

        let (key, action) = book.acquire("conn:a::default", ssh("a"), main_lease("l1"));

        assert_eq!(action, Action::Reuse);
        assert_eq!(book.release_primary(&key), Some(Action::None));
        assert!(book.slot(&key).is_some());
        assert_eq!(
            book.release("a", &main_lease("l1")),
            vec![(key, Action::Teardown)]
        );
        // No slot at all is reported, so `ssh_disconnect` keeps its old teardown.
        assert_eq!(book.release_primary("conn:b::default"), None);
    }

    #[test]
    fn r4_a_destroyed_window_drops_only_its_own_holders() {
        let mut book = SlotBook::default();
        let (key, _) = book.acquire("conn:a::default", ssh("a"), Holder::new("main", "same"));

        book.acquire(
            "conn:a::default",
            ssh("a"),
            Holder::new("session-x", "same"),
        );
        book.acquire(
            "conn:a::default",
            ssh("a"),
            Holder::new("session-x", "other"),
        );

        assert_eq!(
            book.reap_window("session-x"),
            vec![(key.clone(), Action::None)]
        );

        let holders = &book.slot(&key).expect("still held by main").holders;

        assert_eq!(holders.len(), 1);
        assert!(holders.contains(&Holder::new("main", "same")));
    }

    #[test]
    fn r5_a_dead_leased_slot_redials_with_capped_backoff_until_a_terminal_error() {
        let mut book = SlotBook::default();
        let (key, _) = book.acquire("conn:a::default", ssh("a"), main_lease("l1"));

        ready(&mut book, &key);

        assert_eq!(book.on_dead(&key), Action::Redial { attempt: 1 });
        assert!(book.begin_redial(&key, 1));
        assert_eq!(
            book.on_dial_result(&key, Err(FailureKind::Transient)),
            Action::Redial { attempt: 2 }
        );
        // A stale timer does nothing.
        assert!(!book.begin_redial(&key, 1));

        for attempt in 1..=40 {
            assert!(backoff_delay(attempt, 1.0) <= BACKOFF_CAP);
            assert!(backoff_delay(attempt, 0.0) <= BACKOFF_CAP);
        }
        assert_eq!(backoff_delay(40, 1.0), BACKOFF_CAP);
        assert_eq!(backoff_delay(1, 1.0), BACKOFF_BASE);

        let terminal = [
            FailureKind::Locked,
            FailureKind::from_ssh(SshErrorKind::AuthFailed),
            FailureKind::from_ssh(SshErrorKind::HostKeyChanged),
            FailureKind::from_ssh(SshErrorKind::Cancelled),
        ];

        for kind in terminal {
            assert!(book.begin_redial(&key, book.slot(&key).unwrap().attempt));
            assert_eq!(
                book.on_dial_result(&key, Err(kind)),
                Action::None,
                "{kind:?}"
            );
            assert_eq!(book.slot(&key).map(|slot| slot.phase), Some(Phase::Failed));

            // Asking again is what retries a terminal failure.
            let (_, again) = book.acquire(&key, ssh("a"), main_lease("l1"));

            assert_eq!(again, Action::Dial);
            assert_eq!(
                book.on_dial_result(&key, Err(FailureKind::Transient)),
                Action::Redial {
                    attempt: book.slot(&key).unwrap().attempt
                }
            );
        }
    }

    #[test]
    fn r6_rust_never_redials_a_slot_the_primary_holds() {
        let mut book = SlotBook::default();

        book.hold_primary("conn:a::default", ssh("a"), false);
        ready(&mut book, "conn:a::default");
        book.acquire("conn:a::default", ssh("a"), main_lease("l1"));

        assert_eq!(book.on_dead("conn:a::default"), Action::None);
        assert_eq!(
            book.on_dial_result("conn:a::default", Err(FailureKind::Transient)),
            Action::None
        );
        // Once the primary leaves, the leases' loop takes over.
        assert_eq!(
            book.release_primary("conn:a::default"),
            Some(Action::Redial { attempt: 1 })
        );
    }

    #[test]
    fn r7_the_instance_key_follows_the_target_and_nothing_else() {
        assert_eq!(ssh_instance_key("Deploy", "Box", 22), "ssh:deploy@box:22");
        assert_ne!(
            ssh_instance_key("deploy", "box", 22),
            ssh_instance_key("deploy", "box2", 22)
        );
        assert_ne!(
            ssh_instance_key("deploy", "box", 22),
            ssh_instance_key("deploy", "box", 2222)
        );

        // Two profiles of one connection are two scopes, one instance.
        let mut book = SlotBook::default();
        let mut work = ssh("a");

        work.profile = Some("work".to_string());
        book.hold_primary("conn:a::work", work, false);
        ready(&mut book, "conn:a::work");
        let (key, _) = book.acquire("conn:a::default", ssh("a"), main_lease("l1"));

        assert_eq!(key, "conn:a::work");
        assert_eq!(
            descriptor(book.slot(&key).unwrap()).map(|d| d.instance_key),
            Some("ssh:deploy@box:22".to_string())
        );

        // A re-tunnel changes the base and the generation, never the key.
        book.hold_primary(&key, ssh("a"), false);
        assert!(matches!(
            book.on_dial_result(&key, Ok("http://127.0.0.1:42000")),
            Action::Ready { generation: 2 }
        ));
        assert_eq!(
            descriptor(book.slot(&key).unwrap()).map(|d| (d.instance_key, d.base_url)),
            Some((
                "ssh:deploy@box:22".to_string(),
                "http://127.0.0.1:42000".to_string()
            ))
        );
    }

    #[test]
    fn r8_tunnel_auth_is_matched_on_id_and_base() {
        let transport = crate::transport::TransportState::new();
        let auth = |token: &str| crate::transport::ConnectionAuth {
            connection_id: "box".to_string(),
            token: Some(token.to_string()),
            headers: Vec::new(),
        };

        transport.set_tunnel_auth("http://127.0.0.1:41000", auth("one"));
        transport.set_tunnel_auth("http://127.0.0.1:42000", auth("two"));

        let token_for = |url: &str| {
            transport
                .connection_auth_for_dial("box", url)
                .and_then(|auth| auth.token)
        };

        assert_eq!(
            token_for("ws://127.0.0.1:42000/api/ws"),
            Some("two".to_string())
        );
        assert_eq!(
            token_for("ws://127.0.0.1:41000/api/ws"),
            Some("one".to_string())
        );

        transport.forget_tunnel_auth("http://127.0.0.1:41000");

        assert_eq!(token_for("ws://127.0.0.1:41000/api/ws"), None);
        assert_eq!(
            token_for("ws://127.0.0.1:42000/api/ws"),
            Some("two".to_string())
        );
        assert_eq!(
            transport
                .connection_auth_for_url("http://127.0.0.1:41000/api/status")
                .and_then(|auth| auth.token),
            None
        );
        assert_eq!(
            transport
                .connection_auth_for_url("http://127.0.0.1:42000/api/status")
                .and_then(|auth| auth.token),
            Some("two".to_string())
        );
    }

    #[test]
    fn r9_the_local_child_is_reused_across_profiles_and_restarts_in_place() {
        let mut book = SlotBook::default();
        let (key, _) = book.acquire(LOCAL_SLOT, local(), main_lease("l1"));

        ready(&mut book, &key);

        let mut other_profile = local();

        other_profile.profile = Some("home".to_string());

        assert_eq!(book.hold_primary(&key, other_profile, true), Action::Reuse);
        assert_eq!(
            book.slot(&key).and_then(|slot| slot.spec.profile.clone()),
            Some("work".to_string())
        );

        assert_eq!(book.restart(&key, Some("home".to_string())), Action::Dial);
        assert!(matches!(
            book.on_dial_result(&key, Ok("http://127.0.0.1:43000")),
            Action::Ready { generation: 2 }
        ));
        assert_eq!(
            book.slot(&key).map(|slot| slot.holders.len()),
            Some(1),
            "a restart keeps its holders"
        );

        let drained = book.drain();

        assert_eq!(drained.len(), 1, "shutdown takes a held slot too");
        assert!(book.slot(&key).is_none());
    }

    #[test]
    fn r10_dropping_a_connection_ends_its_leased_slots() {
        let mut book = SlotBook::default();
        let (a, _) = book.acquire("conn:a::default", ssh("a"), main_lease("l1"));
        let (b, _) = book.acquire("conn:b::default", ssh("b"), main_lease("l2"));

        ready(&mut book, &a);
        ready(&mut book, &b);

        assert_eq!(
            book.drop_connection("a"),
            vec![(a.clone(), Action::Teardown)]
        );
        assert!(book.slot(&a).is_none());
        assert!(book.slot(&b).is_some());
        assert!(book.slots_for("a").is_empty());
    }

    #[test]
    fn a_failed_first_dial_ends_the_slot_instead_of_looping() {
        let mut book = SlotBook::default();
        let (key, _) = book.acquire("conn:a::default", ssh("a"), main_lease("l1"));

        assert_eq!(
            book.on_dial_result(&key, Err(FailureKind::Transient)),
            Action::Teardown
        );
        assert!(book.slot(&key).is_none());
    }
}
