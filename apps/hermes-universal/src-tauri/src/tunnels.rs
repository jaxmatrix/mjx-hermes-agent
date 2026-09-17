//! Per-connection tunnels (MJXHRM-592).
//!
//! A local or SSH connection is reachable while another connection is active.
//! Each live backend is a SLOT — an SSH connection's session + forward, or the
//! one local child — and a slot lives as long as it has holders: the primary
//! (the active connection's own dial) and any number of `(window label, lease
//! id)` leases. JS only ever sees a loopback base URL, an instance key and a
//! generation; the token is attached in Rust (`TransportState::set_tunnel_auth`).
//!
//! Two layers, on purpose:
//!
//!  * `SlotBook` is pure. Every lifecycle decision — dial, join, reuse,
//!    supersede, teardown, redial, stale result — is a method returning an
//!    `Action`, so the refcount, the single-flight rules and the reconnect
//!    policy are unit-tested with no runtime.
//!  * The runtime half turns actions into effects: waiters on a `watch`
//!    channel, the `tunnel://{id}/changed` and `/status` events, the backoff
//!    timer, the holder reaper, and the dials in `ssh` and `local_backend`.
//!
//! Every dial carries a SERIAL. A result is credited only while its serial is
//! the slot's in-flight one; anything else installs nothing. An interactive
//! request supersedes a background dial: cancel, drain, redial (upstream
//! desktop's `apps/desktop/electron/ssh-bootstrap-coordinator.ts`).

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Webview, Wry};
use tokio::sync::watch;

use crate::ssh::error::SshErrorKind;

/// The one local child's slot key.
pub const LOCAL_SLOT: &str = "local";
/// The local child's instance key and fingerprint. One per install.
pub const LOCAL_INSTANCE_KEY: &str = "local";

pub const BACKOFF_BASE: Duration = Duration::from_secs(1);
pub const BACKOFF_CAP: Duration = Duration::from_secs(30);
/// Full jitter can draw zero; a floor keeps a dead host from being hammered.
const BACKOFF_FLOOR: Duration = Duration::from_millis(250);

/// An unheld slot waits this long before teardown, so a reloading window's new
/// page re-acquires the live tunnel instead of redialling it. The ONLY timer on a
/// hold: a hold itself never ages out (hidden, occluded and paused webviews
/// throttle their timers without bound), it ends on release, on its window's
/// page load or destroy, on a connection drop, or at exit — the lifecycle rule
/// `transport::reap_window_sockets` follows.
pub const LINGER_MS: u64 = 15_000;
pub const REAP_TICK: Duration = Duration::from_millis(LINGER_MS);

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

/// What a slot dials.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SlotSpec {
    pub connection_id: String,
    pub kind: SlotKind,
    pub instance_key: String,
    /// The target's identity: host, user, port, key path and remote hermes
    /// path. A different fingerprint at the same key is a different backend.
    pub fingerprint: String,
}

/// The dial a slot is waiting on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InFlight {
    pub serial: u64,
    pub interactive: bool,
    pub attempt_id: String,
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
    pub dial: Option<InFlight>,
    /// When the slot lost its last holder, while it lingers.
    pub unheld_since: Option<u64>,
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
            dial: None,
            unheld_since: None,
        }
    }

    fn unheld(&self) -> bool {
        !self.primary && self.holders.is_empty()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    None,
    /// Start dial `serial`; the caller owns it.
    Dial {
        serial: u64,
    },
    /// A dial is in flight; wait for it.
    Join,
    /// Live and ready; use it as is.
    Reuse,
    /// Cancel the previous dial, wait for it to drain, then dial `serial`.
    /// `retarget`: the target changed, so the leases ended and the previous
    /// backend's resources go before the new dial.
    Supersede {
        serial: u64,
        previous: Option<InFlight>,
        retarget: bool,
    },
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
    /// The result belongs to a dial the slot no longer waits on: install
    /// nothing, and drop only what that dial built.
    Stale,
}

#[derive(Debug, Default)]
pub struct SlotBook {
    slots: BTreeMap<String, Slot>,
    /// Serials are unique across the book, so a recreated slot can never
    /// credit a dial that belonged to its predecessor.
    serial: u64,
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

    fn begin(&mut self, key: &str, interactive: bool, attempt_id: &str) -> u64 {
        self.serial += 1;

        let serial = self.serial;
        let slot = self
            .slots
            .get_mut(key)
            .expect("a slot being dialled exists");

        slot.phase = Phase::Connecting;
        slot.dial = Some(InFlight {
            serial,
            interactive,
            attempt_id: attempt_id.to_string(),
        });

        serial
    }

    /// What an existing slot does for a request (a lease or the primary).
    fn request(
        &mut self,
        key: &str,
        spec: SlotSpec,
        alive: bool,
        interactive: bool,
        attempt_id: &str,
    ) -> Action {
        let slot = self.slots.get_mut(key).expect("a requested slot exists");

        // A different target at the same key is a different backend: never
        // reuse it, and end the leases that were riding the old one.
        if slot.spec.fingerprint != spec.fingerprint {
            let previous = slot.dial.take();

            slot.spec = spec;
            slot.holders.clear();
            slot.base_url = None;
            slot.failure = None;

            let serial = self.begin(key, interactive, attempt_id);

            return Action::Supersede {
                serial,
                previous,
                retarget: true,
            };
        }

        match slot.phase {
            Phase::Ready if alive => Action::Reuse,
            Phase::Connecting => match &slot.dial {
                // A person asking must not wait on a dial that cannot ask them.
                Some(dial) if interactive && !dial.interactive => {
                    let previous = slot.dial.take();
                    let serial = self.begin(key, interactive, attempt_id);

                    Action::Supersede {
                        serial,
                        previous,
                        retarget: false,
                    }
                }
                _ => Action::Join,
            },
            _ => Action::Dial {
                serial: self.begin(key, interactive, attempt_id),
            },
        }
    }

    /// A lease joins the connection's live slot, or creates one at `key`.
    pub fn acquire(
        &mut self,
        key: &str,
        spec: SlotSpec,
        holder: Holder,
        interactive: bool,
        attempt_id: &str,
    ) -> (String, Action) {
        let key = self
            .key_for(&spec.connection_id)
            .unwrap_or_else(|| key.to_string());

        let action = if self.slots.contains_key(&key) {
            self.request(&key, spec, true, interactive, attempt_id)
        } else {
            self.slots.insert(key.clone(), Slot::new(spec));

            Action::Dial {
                serial: self.begin(&key, interactive, attempt_id),
            }
        };

        let slot = self.slots.get_mut(&key).expect("the acquired slot exists");

        slot.holders.insert(holder);
        slot.unheld_since = None;

        (key, action)
    }

    /// The active connection's own dial. `alive` is the caller's liveness read
    /// of what the slot holds: a ready slot whose session died is redialled,
    /// never reused — and never closed while it is still serving someone.
    pub fn hold_primary(
        &mut self,
        key: &str,
        spec: SlotSpec,
        alive: bool,
        interactive: bool,
        attempt_id: &str,
    ) -> (String, Action) {
        let key = self
            .key_for(&spec.connection_id)
            .unwrap_or_else(|| key.to_string());

        let action = if self.slots.contains_key(&key) {
            self.request(&key, spec, alive, interactive, attempt_id)
        } else {
            self.slots.insert(key.clone(), Slot::new(spec));

            Action::Dial {
                serial: self.begin(&key, interactive, attempt_id),
            }
        };

        let slot = self.slots.get_mut(&key).expect("the held slot exists");

        slot.primary = true;
        slot.unheld_since = None;

        (key, action)
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

    /// A lease let go. A slot that leaves unheld lingers one reaper tick, so a
    /// Connect that releases once it is up, or a consumer re-acquiring right
    /// away, finds the tunnel still there. Returns the slots now lingering.
    pub fn release(&mut self, connection_id: &str, holder: &Holder, now: u64) -> Vec<String> {
        let mut lingering = Vec::new();

        for (key, slot) in &mut self.slots {
            if slot.spec.connection_id != connection_id || !slot.holders.remove(holder) {
                continue;
            }

            if slot.unheld() && slot.unheld_since.is_none() {
                slot.unheld_since = Some(now);
                lingering.push(key.clone());
            }
        }

        lingering
    }

    /// A window reloaded or went away: its leases end, and a slot that leaves
    /// unheld lingers for the new page to re-acquire. Returns those slots.
    pub fn reap_window(&mut self, label: &str, now: u64) -> Vec<String> {
        let mut lingering = Vec::new();

        for (key, slot) in &mut self.slots {
            let before = slot.holders.len();

            slot.holders.retain(|holder| holder.window != label);

            if slot.holders.len() != before && slot.unheld() && slot.unheld_since.is_none() {
                slot.unheld_since = Some(now);
                lingering.push(key.clone());
            }
        }

        lingering
    }

    /// The reaper's tick: tear down slots that have lingered unheld for a full
    /// tick. Holders are never aged out here.
    pub fn expire(&mut self, now: u64) -> Vec<(String, Action)> {
        let mut out = Vec::new();

        for (key, slot) in &mut self.slots {
            if !slot.unheld() {
                slot.unheld_since = None;
                continue;
            }

            match slot.unheld_since {
                None => slot.unheld_since = Some(now),
                Some(since) if now.saturating_sub(since) >= LINGER_MS => {
                    out.push((key.clone(), Action::Teardown));
                }
                Some(_) => {}
            }
        }

        for (key, _) in &out {
            self.slots.remove(key);
        }

        out
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

    pub fn on_dial_result(
        &mut self,
        key: &str,
        serial: u64,
        result: Result<&str, FailureKind>,
    ) -> Action {
        let Some(slot) = self.slots.get_mut(key) else {
            return Action::Stale;
        };

        if slot.dial.as_ref().map(|dial| dial.serial) != Some(serial) {
            return Action::Stale;
        }

        slot.dial = None;

        match result {
            Ok(base_url) => {
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

    /// The backoff timer fired. The serial to dial, or `None` when the attempt
    /// is stale or unwanted.
    pub fn begin_redial(&mut self, key: &str, attempt: u32, attempt_id: &str) -> Option<u64> {
        let slot = self.slots.get(key)?;

        if slot.phase != Phase::Retrying
            || slot.attempt != attempt
            || slot.primary
            || slot.holders.is_empty()
        {
            return None;
        }

        Some(self.begin(key, false, attempt_id))
    }

    /// "Restart backend": the explicit respawn, keeping every holder. A restart
    /// during a dial supersedes that dial once it has drained.
    pub fn restart(&mut self, key: &str, attempt_id: &str) -> Action {
        let Some(slot) = self.slots.get_mut(key) else {
            return Action::None;
        };

        let previous = slot.dial.take();
        let serial = self.begin(key, true, attempt_id);

        match previous {
            Some(previous) => Action::Supersede {
                serial,
                previous: Some(previous),
                retarget: false,
            },
            None => Action::Dial { serial },
        }
    }

    /// A connection was edited (dial fields) or removed. Its leases end; a slot
    /// the primary still holds stays until the primary lets it go or redials a
    /// new target.
    pub fn drop_connection(&mut self, connection_id: &str) -> Vec<(String, Action)> {
        self.slots_for(connection_id)
            .into_iter()
            .map(|key| {
                let slot = self.slots.get_mut(&key).expect("key was just listed");

                slot.holders.clear();

                if slot.primary {
                    (key, Action::None)
                } else {
                    self.slots.remove(&key);

                    (key, Action::Teardown)
                }
            })
            .collect()
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

/// The dial identity of an SSH target (upstream `sshConfigFingerprint`, minus
/// the profile: one backend serves every profile).
pub fn ssh_fingerprint(
    user: &str,
    host: &str,
    port: u16,
    key_path: Option<&str>,
    remote_hermes_path: Option<&str>,
) -> String {
    format!(
        "{}\n{}\n{}",
        ssh_instance_key(user, host, port),
        key_path.unwrap_or_default().trim(),
        remote_hermes_path.unwrap_or_default().trim()
    )
}

/// Milliseconds on a monotonic clock. Only the linger reads it, and a
/// suspend/resume or a wall-clock jump must not end it early.
fn now_ms() -> u64 {
    static START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();

    START
        .get_or_init(std::time::Instant::now)
        .elapsed()
        .as_millis() as u64
}

/// Whether a page-load event ends the leases its webview's page held. A load
/// STARTING is a reload (or a first load, which holds nothing): the old page's
/// JS, and every hold it took, is gone.
pub fn reaps_on_page_load(event: &tauri::webview::PageLoadEvent) -> bool {
    matches!(event, tauri::webview::PageLoadEvent::Started)
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
    /// The slot is gone, or no longer serves the leases that held it.
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
    /// One per in-flight dial serial; flips to true once that dial settled.
    drains: HashMap<u64, watch::Sender<bool>>,
    /// Serialises installs and teardowns of one slot key's resources.
    installs: HashMap<String, Arc<tokio::sync::Mutex<()>>>,
    /// The install's SSH identity, remembered for Rust-driven redials.
    installation_id: Option<String>,
}

enum Effect {
    Teardown { key: String, kind: SlotKind },
    Redial { key: String, attempt: u32 },
}

/// A dial the caller has to run.
pub(crate) struct Dial {
    pub key: String,
    pub serial: u64,
    /// Subscribed under the same lock that began the dial, so no settle can
    /// land before the caller is listening.
    pub outcome: watch::Receiver<Outcome>,
    /// The superseded dial to cancel and wait out first.
    previous: Option<(InFlight, Option<watch::Receiver<bool>>)>,
    /// The previous target's resources go before this dial.
    retarget: bool,
}

/// What a request for a slot turned into.
pub(crate) enum Hold {
    Reuse(String),
    Join(String, watch::Receiver<Outcome>),
    Dial(Dial),
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

/// Mark dial `serial` as begun: waiters see `Pending`, the UI sees `connecting`.
fn begun(
    app: &AppHandle,
    inner: &mut Inner,
    key: String,
    serial: u64,
    previous: Option<InFlight>,
    retarget: bool,
) -> Dial {
    let tx = signal(inner, &key);

    tx.send_replace(Outcome::Pending);

    let outcome = tx.subscribe();

    inner.drains.insert(serial, watch::channel(false).0);

    if let Some(slot) = inner.book.slot(&key) {
        if retarget {
            // The leases on the old target are over.
            emit_status(app, &status_of(slot, StatusPhase::Closed, None));
        }

        emit_status(app, &status_of(slot, StatusPhase::Connecting, None));
    }

    let previous = previous.map(|dial| {
        let drained = inner.drains.get(&dial.serial).map(watch::Sender::subscribe);

        (dial, drained)
    });

    Dial {
        key,
        serial,
        outcome,
        previous,
        retarget,
    }
}

/// Turn a book request for `key` into what the caller does. Under the lock.
fn hold_for(app: &AppHandle, inner: &mut Inner, key: String, action: Action) -> Hold {
    match action {
        Action::Reuse => Hold::Reuse(key),
        Action::Dial { serial } => Hold::Dial(begun(app, inner, key, serial, None, false)),
        Action::Supersede {
            serial,
            previous,
            retarget,
        } => Hold::Dial(begun(app, inner, key, serial, previous, retarget)),
        _ => {
            let rx = signal(inner, &key).subscribe();

            Hold::Join(key, rx)
        }
    }
}

/// Wait out a superseded dial, and drop a retargeted slot's old resources,
/// before running this one.
pub(crate) async fn prepare(
    app: &AppHandle,
    dial: &mut Dial,
    kind: SlotKind,
    own_attempt: Option<&Arc<crate::ssh::Attempt>>,
) {
    if let Some((previous, drained)) = dial.previous.take() {
        if kind == SlotKind::Ssh {
            crate::ssh::cancel_attempt(app, &previous.attempt_id, own_attempt).await;
        }

        if let Some(mut drained) = drained {
            let _ = drained.wait_for(|done| *done).await;
        }
    }

    if dial.retarget {
        let _guard = install_lock(app, &dial.key).await;

        teardown_resources(app, &dial.key, kind).await;
    }
}

/// The lock a slot key's installs and teardowns take.
pub(crate) async fn install_lock(app: &AppHandle, key: &str) -> tokio::sync::OwnedMutexGuard<()> {
    let lock = locked(app, |inner| {
        Arc::clone(
            inner
                .installs
                .entry(key.to_string())
                .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))),
        )
    });

    lock.lock_owned().await
}

/// Whether dial `serial` is still the one `key` waits on. Checked under the
/// install lock before anything is installed.
pub(crate) fn is_current(app: &AppHandle, key: &str, serial: u64) -> bool {
    locked(app, |inner| {
        inner
            .book
            .slot(key)
            .and_then(|slot| slot.dial.as_ref())
            .is_some_and(|dial| dial.serial == serial)
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

    let _guard = install_lock(app, key).await;

    // A slot re-created at this key while we waited owns what is there now;
    // its install replaces the old resources.
    if locked(app, |inner| inner.book.slot(key).is_some()) {
        return;
    }

    teardown_resources(app, key, kind).await;
}

async fn teardown_resources(app: &AppHandle, key: &str, kind: SlotKind) {
    match kind {
        SlotKind::Ssh => crate::ssh::teardown_scope(app, key).await,
        SlotKind::Local => crate::local_backend::kill_child(app).await,
    }
}

fn snapshot(inner: &Inner) -> HashMap<String, Slot> {
    inner
        .book
        .slots
        .iter()
        .map(|(key, slot)| (key.clone(), slot.clone()))
        .collect()
}

fn book_effects(
    app: &AppHandle,
    inner: &mut Inner,
    before: HashMap<String, Slot>,
    actions: Vec<(String, Action)>,
) -> Vec<Effect> {
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

pub(crate) fn hold_primary(
    app: &AppHandle,
    key: &str,
    spec: SlotSpec,
    alive: bool,
    interactive: bool,
    attempt_id: &str,
) -> Hold {
    locked(app, |inner| {
        let (key, action) = inner
            .book
            .hold_primary(key, spec, alive, interactive, attempt_id);

        hold_for(app, inner, key, action)
    })
}

/// The slot key a connection is live at, if any.
pub(crate) fn key_for(app: &AppHandle, connection_id: &str) -> Option<String> {
    locked(app, |inner| inner.book.key_for(connection_id))
}

/// Record dial `serial`'s outcome and act on it.
pub(crate) fn finish_dial(
    app: &AppHandle,
    key: &str,
    serial: u64,
    result: Result<String, TunnelError>,
) {
    let effects = locked(app, |inner| {
        if let Some(drained) = inner.drains.remove(&serial) {
            drained.send_replace(true);
        }

        let before = inner.book.slot(key).cloned();
        let action =
            inner
                .book
                .on_dial_result(key, serial, result.as_deref().map_err(|error| error.kind));

        match (action, &result) {
            (Action::Stale, _) => vec![],

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
                .unwrap_or_default(),

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
            let spec = inner.book.slot(&key)?.spec.clone();
            let attempt_id = format!("tunnel-{}", spec.connection_id);
            let serial = inner.book.begin_redial(&key, attempt, &attempt_id)?;
            let dial = begun(&app, inner, key.clone(), serial, None, false);

            Some((dial, spec, attempt_id, inner.installation_id.clone()))
        });

        if let Some((dial, spec, attempt_id, installation_id)) = plan {
            run(&app, dial, &spec, installation_id, false, &attempt_id).await;
        }
    });
}

/// Run a dial to completion; it settles itself through `finish_dial`.
async fn run(
    app: &AppHandle,
    mut dial: Dial,
    spec: &SlotSpec,
    installation_id: Option<String>,
    interactive: bool,
    attempt_id: &str,
) {
    match spec.kind {
        // The SSH dial prepares itself, racing the drain against its cancel.
        SlotKind::Ssh => {
            crate::ssh::dial_tunnel(
                app,
                dial,
                &spec.connection_id,
                installation_id,
                interactive,
                attempt_id,
            )
            .await
        }
        SlotKind::Local => {
            prepare(app, &mut dial, spec.kind, None).await;
            crate::local_backend::dial_tunnel(app, dial.serial).await
        }
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

/// "Restart backend": begin the respawn in place. `None` when there is no
/// slot, in which case the caller spawns through the primary path.
pub(crate) fn begin_restart(app: &AppHandle, key: &str, attempt_id: &str) -> Option<Dial> {
    locked(app, |inner| match inner.book.restart(key, attempt_id) {
        Action::Dial { serial } => Some(begun(app, inner, key.to_string(), serial, None, false)),
        Action::Supersede {
            serial, previous, ..
        } => Some(begun(app, inner, key.to_string(), serial, previous, false)),
        _ => None,
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

/// A window reloaded (`PageLoadEvent::Started`) or was destroyed: its leases
/// end, and whatever that leaves unheld lingers one reaper tick.
pub fn reap_window(app: &AppHandle, label: &str) {
    locked(app, |inner| {
        inner.book.reap_window(label, now_ms());
    });
}

/// The reaper: every tick, tear down slots that lingered unheld for a full tick. Started once from `setup`.
pub fn start_reaper(app: &AppHandle) {
    let app = app.clone();

    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(REAP_TICK).await;

            let effects = locked(&app, |inner| {
                let before = snapshot(inner);
                let actions = inner.book.expire(now_ms());

                book_effects(&app, inner, before, actions)
            });

            apply(&app, effects).await;
        }
    });
}

/// A connection's dial fields were edited, or it was removed.
pub(crate) async fn drop_connection(app: &AppHandle, connection_id: &str) {
    let effects = locked(app, |inner| {
        let before = snapshot(inner);
        let actions = inner.book.drop_connection(connection_id);

        for (key, _) in &actions {
            if let Some(slot) = inner.book.slot(key) {
                // Still the primary's; its leases are over all the same.
                emit_status(app, &status_of(slot, StatusPhase::Closed, None));
            }
        }

        book_effects(app, inner, before, actions)
    });

    apply(app, effects).await;
}

/// One step of the exit sequence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ShutdownStep {
    /// Kill the local child, whether or not a slot holds it. Unbounded.
    KillLocal,
    /// Close an SSH scope's session. Bounded by the shared close deadline.
    CloseSsh(String),
}

/// The exit order: the local child first, then every SSH close. A hanging SSH
/// close runs into its deadline; it must never stand between the app and the
/// kill that keeps `hermes serve` from outliving it.
pub fn shutdown_plan(slots: &[(String, SlotKind)]) -> Vec<ShutdownStep> {
    std::iter::once(ShutdownStep::KillLocal)
        .chain(
            slots
                .iter()
                .filter(|(_, kind)| *kind == SlotKind::Ssh)
                .map(|(key, _)| ShutdownStep::CloseSsh(key.clone())),
        )
        .collect()
}

/// `RunEvent::Exit`: runs `shutdown_plan` in its order.
pub fn shutdown(app: &AppHandle) {
    let slots: Vec<(String, SlotKind)> = locked(app, |inner| {
        inner.signals.clear();
        inner
            .book
            .drain()
            .into_iter()
            .map(|(key, slot)| (key, slot.spec.kind))
            .collect()
    });

    let app = app.clone();

    tauri::async_runtime::block_on(async move {
        // A session close sends a disconnect; a dead network must not hold the
        // process open, so all the closes share one deadline.
        let mut deadline = None;

        for step in shutdown_plan(&slots) {
            match step {
                ShutdownStep::KillLocal => crate::local_backend::kill_child(&app).await,
                ShutdownStep::CloseSsh(key) => {
                    let until = *deadline.get_or_insert_with(|| {
                        tokio::time::Instant::now() + Duration::from_secs(3)
                    });

                    let _ = tokio::time::timeout_at(until, crate::ssh::teardown_scope(&app, &key))
                        .await;
                }
            }
        }
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
        input: crate::ssh::target::SshTargetInput,
    },
}

/// Reach a local or SSH connection that may not be the active one.
///
/// `attempt_id` names an interactive dial's prompts; a background dial runs as
/// `tunnel-{connectionId}`.
#[tauri::command]
pub async fn tunnel_acquire(
    app: AppHandle,
    webview: Webview<Wry>,
    connection_id: String,
    lease_id: String,
    installation_id: Option<String>,
    interactive: bool,
    attempt_id: Option<String>,
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
                    fingerprint: LOCAL_INSTANCE_KEY.to_string(),
                },
            )
        }
        TunnelTarget::Ssh { scope, input } => {
            let (instance_key, fingerprint) =
                crate::ssh::identity_for(&input).map_err(|e| TunnelError::from_ssh(&e))?;

            (
                scope,
                SlotSpec {
                    connection_id: connection_id.clone(),
                    kind: SlotKind::Ssh,
                    instance_key,
                    fingerprint,
                },
            )
        }
    };

    let attempt_id = attempt_id
        .filter(|id| interactive && !id.trim().is_empty())
        .unwrap_or_else(|| format!("tunnel-{connection_id}"));
    let holder = Holder::new(webview.window().label(), lease_id);

    let (hold, spec, installation_id) = locked(&app, |inner| {
        if installation_id.is_some() {
            inner.installation_id = installation_id.clone();
        }

        let (key, action) = inner
            .book
            .acquire(&key, spec, holder, interactive, &attempt_id);
        let spec = inner
            .book
            .slot(&key)
            .expect("an acquired slot exists")
            .spec
            .clone();
        let hold = hold_for(&app, inner, key, action);

        (hold, spec, inner.installation_id.clone())
    });

    let rx = match hold {
        Hold::Reuse(key) => {
            return locked(&app, |inner| inner.book.slot(&key).and_then(descriptor)).ok_or_else(
                || TunnelError::new(FailureKind::Transient, "the tunnel has no address"),
            )
        }
        Hold::Join(_, rx) => rx,
        Hold::Dial(dial) => {
            let rx = dial.outcome.clone();

            run(&app, dial, &spec, installation_id, interactive, &attempt_id).await;

            rx
        }
    };

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

    locked(&app, |inner| {
        inner.book.release(&connection_id, &holder, now_ms());
    });

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
            fingerprint: ssh_fingerprint("deploy", "box", 22, None, None),
        }
    }

    fn local() -> SlotSpec {
        SlotSpec {
            connection_id: "local".to_string(),
            kind: SlotKind::Local,
            instance_key: LOCAL_INSTANCE_KEY.to_string(),
            fingerprint: LOCAL_INSTANCE_KEY.to_string(),
        }
    }

    fn lease(lease: &str) -> Holder {
        Holder::new("main", lease)
    }

    fn serial_of(action: &Action) -> u64 {
        match action {
            Action::Dial { serial } | Action::Supersede { serial, .. } => *serial,
            other => panic!("not a dial: {other:?}"),
        }
    }

    fn acquire(book: &mut SlotBook, key: &str, spec: SlotSpec, holder: Holder) -> (String, Action) {
        book.acquire(key, spec, holder, false, "tunnel-x")
    }

    /// Land a dial successfully.
    fn ready(book: &mut SlotBook, key: &str, action: &Action) {
        assert!(matches!(
            book.on_dial_result(key, serial_of(action), Ok("http://127.0.0.1:41000")),
            Action::Ready { .. }
        ));
    }

    #[test]
    fn r1_two_holders_share_one_dial_and_the_last_release_tears_down() {
        let mut book = SlotBook::default();

        let (key, first) = acquire(&mut book, "conn:a::default", ssh("a"), lease("l1"));
        let (joined, second) = acquire(&mut book, "conn:a::default", ssh("a"), lease("l2"));

        assert!(matches!(first, Action::Dial { .. }));
        assert_eq!(second, Action::Join);
        assert_eq!(joined, key);

        ready(&mut book, &key, &first);

        assert!(book.release("a", &lease("l1"), 0).is_empty());
        assert_eq!(book.release("a", &lease("l2"), 0), vec![key.clone()]);
        assert!(
            book.expire(LINGER_MS - 1).is_empty(),
            "the last release lingers"
        );
        assert_eq!(
            book.expire(LINGER_MS),
            vec![(key.clone(), Action::Teardown)]
        );
        assert!(book.slot(&key).is_none());
    }

    #[test]
    fn gap1_the_primary_adopts_a_lease_slot_whatever_the_profile() {
        let mut book = SlotBook::default();
        let (key, dial) = acquire(&mut book, "conn:a::default", ssh("a"), lease("l1"));

        ready(&mut book, &key, &dial);

        // The primary asks with the scope a `work` profile used to produce.
        let (primary_key, action) = book.hold_primary("conn:a::work", ssh("a"), true, false, "p");

        assert_eq!(primary_key, "conn:a::default");
        assert_eq!(action, Action::Reuse);
        assert_eq!(book.slots_for("a").len(), 1);
    }

    #[test]
    fn r3_releasing_the_primary_keeps_a_leased_slot() {
        let mut book = SlotBook::default();
        let (key, dial) = book.hold_primary("conn:a::default", ssh("a"), false, false, "p");

        ready(&mut book, &key, &dial);

        let (_, action) = acquire(&mut book, &key, ssh("a"), lease("l1"));

        assert_eq!(action, Action::Reuse);
        assert_eq!(book.release_primary(&key), Some(Action::None));
        assert!(book.slot(&key).is_some());
        assert_eq!(book.release("a", &lease("l1"), 0), vec![key]);
        assert_eq!(book.release_primary("conn:b::default"), None);
    }

    #[test]
    fn gap2_a_result_from_a_dial_the_slot_no_longer_waits_on_is_stale() {
        let mut book = SlotBook::default();
        let (key, old) = acquire(&mut book, "conn:a::default", ssh("a"), lease("l1"));

        // Released mid-dial and reaped, then acquired again: a new dial for a
        // new slot.
        book.release("a", &lease("l1"), 0);
        book.expire(LINGER_MS);
        let (_, new) = acquire(&mut book, &key, ssh("a"), lease("l2"));

        assert_ne!(serial_of(&old), serial_of(&new));
        assert_eq!(
            book.on_dial_result(&key, serial_of(&old), Ok("http://127.0.0.1:1")),
            Action::Stale
        );
        assert_eq!(
            book.slot(&key).map(|slot| slot.phase),
            Some(Phase::Connecting)
        );
        assert!(matches!(
            book.on_dial_result(&key, serial_of(&new), Ok("http://127.0.0.1:2")),
            Action::Ready { generation: 1 }
        ));
    }

    #[test]
    fn gap3_a_restart_during_a_dial_supersedes_it() {
        let mut book = SlotBook::default();
        let (key, first) = book.hold_primary(LOCAL_SLOT, local(), false, false, "p");

        let restart = book.restart(&key, "restart");

        assert!(
            matches!(&restart, Action::Supersede { previous: Some(previous), retarget: false, .. } if previous.serial == serial_of(&first)),
            "{restart:?}"
        );
        // The first spawn's result lands after the restart began: it is stale.
        assert_eq!(
            book.on_dial_result(&key, serial_of(&first), Ok("http://127.0.0.1:1")),
            Action::Stale
        );
        assert!(matches!(
            book.on_dial_result(&key, serial_of(&restart), Ok("http://127.0.0.1:2")),
            Action::Ready { generation: 1 }
        ));
        // Idle, a restart is a plain dial.
        assert!(matches!(book.restart(&key, "again"), Action::Dial { .. }));
    }

    #[test]
    fn gap4_a_different_target_is_never_reused_and_ends_its_leases() {
        let mut book = SlotBook::default();
        let (key, dial) = book.hold_primary("", ssh("legacy"), false, false, "p");

        ready(&mut book, &key, &dial);
        acquire(&mut book, &key, ssh("legacy"), lease("l1"));

        let mut moved = ssh("legacy");

        moved.fingerprint = ssh_fingerprint("deploy", "box2", 22, None, None);

        let (_, action) = book.hold_primary("", moved.clone(), true, false, "p2");

        assert!(
            matches!(action, Action::Supersede { retarget: true, .. }),
            "{action:?}"
        );

        let slot = book.slot(&key).unwrap();

        assert!(slot.holders.is_empty());
        assert_eq!(slot.spec, moved);
        assert_eq!(slot.base_url, None);
    }

    #[test]
    fn gap5_a_reloading_window_keeps_its_slot_for_one_tick() {
        let mut book = SlotBook::default();
        let (key, dial) = book.acquire("conn:a::default", ssh("a"), lease("old-page"), false, "t");

        ready(&mut book, &key, &dial);

        assert_eq!(book.reap_window("main", 1_000), vec![key.clone()]);
        assert!(book.slot(&key).is_some(), "not torn down at once");

        let (_, again) = book.acquire(&key, ssh("a"), lease("new-page"), false, "t");

        assert_eq!(again, Action::Reuse);
        assert!(book.expire(1_000 + LINGER_MS).is_empty());
        assert!(book.slot(&key).is_some());

        // This time nobody comes back: the slot goes after a full tick.
        book.reap_window("main", 20_000);

        assert!(book.expire(20_000 + LINGER_MS - 1).is_empty());
        assert_eq!(
            book.expire(20_000 + LINGER_MS),
            vec![(key.clone(), Action::Teardown)]
        );
    }

    #[test]
    fn a_hold_never_ages_out_during_its_dial_or_after() {
        let mut book = SlotBook::default();
        let (key, dial) = book.acquire("conn:a::default", ssh("a"), lease("cold"), false, "t");

        // A cold spawn, or a Connect waiting on a passphrase, for ten minutes.
        assert!(book.expire(10 * 60_000).is_empty());
        assert!(book.slot(&key).unwrap().holders.contains(&lease("cold")));

        ready(&mut book, &key, &dial);

        // A tray-hidden window whose timers stopped for a day still holds it.
        assert!(book.expire(24 * 60 * 60_000).is_empty());
        assert!(book.slot(&key).unwrap().holders.contains(&lease("cold")));
    }

    #[test]
    fn quit_kills_the_local_child_before_any_ssh_close() {
        // The drained book is key-ordered: `conn:*` sorts before `local`.
        let slots = vec![
            ("conn:a::default".to_string(), SlotKind::Ssh),
            (LOCAL_SLOT.to_string(), SlotKind::Local),
            ("conn:b::default".to_string(), SlotKind::Ssh),
        ];

        assert_eq!(
            shutdown_plan(&slots),
            vec![
                ShutdownStep::KillLocal,
                ShutdownStep::CloseSsh("conn:a::default".to_string()),
                ShutdownStep::CloseSsh("conn:b::default".to_string()),
            ]
        );
        // No local slot: the child may still be running, so it is killed anyway.
        assert_eq!(shutdown_plan(&[]), vec![ShutdownStep::KillLocal]);
    }

    #[test]
    fn only_a_page_load_that_starts_reaps() {
        assert!(reaps_on_page_load(&tauri::webview::PageLoadEvent::Started));
        assert!(!reaps_on_page_load(
            &tauri::webview::PageLoadEvent::Finished
        ));
    }

    #[test]
    fn gap8_an_interactive_request_supersedes_a_background_dial_only() {
        let mut book = SlotBook::default();
        let (key, background) = acquire(&mut book, "conn:a::default", ssh("a"), lease("l1"));

        let (_, connect) = book.acquire(&key, ssh("a"), lease("l2"), true, "connect-1");

        assert!(
            matches!(&connect, Action::Supersede { previous: Some(previous), retarget: false, .. } if previous.serial == serial_of(&background) && !previous.interactive),
            "{connect:?}"
        );
        assert_eq!(
            book.slot(&key)
                .and_then(|slot| slot.dial.clone())
                .map(|dial| (dial.interactive, dial.attempt_id)),
            Some((true, "connect-1".to_string()))
        );

        // An interactive dial in flight is joined, not superseded again.
        let (_, second) = book.acquire(&key, ssh("a"), lease("l3"), true, "connect-2");

        assert_eq!(second, Action::Join);
    }

    #[test]
    fn r4_a_destroyed_window_drops_only_its_own_holders() {
        let mut book = SlotBook::default();
        let (key, _) = acquire(
            &mut book,
            "conn:a::default",
            ssh("a"),
            Holder::new("main", "same"),
        );

        acquire(&mut book, &key, ssh("a"), Holder::new("session-x", "same"));
        acquire(&mut book, &key, ssh("a"), Holder::new("session-x", "other"));

        assert!(book.reap_window("session-x", 0).is_empty());

        let holders = &book.slot(&key).expect("still held by main").holders;

        assert_eq!(holders.len(), 1);
        assert!(holders.contains(&Holder::new("main", "same")));
    }

    #[test]
    fn r5_a_dead_leased_slot_redials_with_capped_backoff_until_a_terminal_error() {
        let mut book = SlotBook::default();
        let (key, dial) = acquire(&mut book, "conn:a::default", ssh("a"), lease("l1"));

        ready(&mut book, &key, &dial);

        assert_eq!(book.on_dead(&key), Action::Redial { attempt: 1 });
        let serial = book.begin_redial(&key, 1, "t").expect("the redial runs");
        assert_eq!(
            book.on_dial_result(&key, serial, Err(FailureKind::Transient)),
            Action::Redial { attempt: 2 }
        );
        assert!(
            book.begin_redial(&key, 1, "t").is_none(),
            "a stale timer does nothing"
        );

        for attempt in 1..=40 {
            assert!(backoff_delay(attempt, 1.0) <= BACKOFF_CAP);
        }
        assert_eq!(backoff_delay(40, 1.0), BACKOFF_CAP);
        assert_eq!(backoff_delay(1, 1.0), BACKOFF_BASE);

        for kind in [
            FailureKind::Locked,
            FailureKind::from_ssh(SshErrorKind::AuthFailed),
            FailureKind::from_ssh(SshErrorKind::HostKeyChanged),
            FailureKind::from_ssh(SshErrorKind::Cancelled),
        ] {
            let attempt = book.slot(&key).unwrap().attempt;
            let serial = book.begin_redial(&key, attempt, "t").expect("retrying");

            assert_eq!(
                book.on_dial_result(&key, serial, Err(kind)),
                Action::None,
                "{kind:?}"
            );
            assert_eq!(book.slot(&key).map(|slot| slot.phase), Some(Phase::Failed));

            // Asking again is what retries a terminal failure.
            let (_, again) = acquire(&mut book, &key, ssh("a"), lease("l1"));

            assert!(matches!(again, Action::Dial { .. }));
            assert!(matches!(
                book.on_dial_result(&key, serial_of(&again), Err(FailureKind::Transient)),
                Action::Redial { .. }
            ));
        }
    }

    #[test]
    fn r6_rust_never_redials_a_slot_the_primary_holds() {
        let mut book = SlotBook::default();
        let (key, dial) = book.hold_primary("conn:a::default", ssh("a"), false, false, "p");

        ready(&mut book, &key, &dial);
        acquire(&mut book, &key, ssh("a"), lease("l1"));

        assert_eq!(book.on_dead(&key), Action::None);
        assert_eq!(
            book.release_primary(&key),
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
        assert_ne!(
            ssh_fingerprint("deploy", "box", 22, Some("~/.ssh/a"), None),
            ssh_fingerprint("deploy", "box", 22, Some("~/.ssh/b"), None)
        );

        let mut book = SlotBook::default();
        let (key, dial) = book.hold_primary("conn:a::default", ssh("a"), false, false, "p");

        ready(&mut book, &key, &dial);

        // A re-tunnel changes the base and the generation, never the key.
        let (_, redial) = book.hold_primary(&key, ssh("a"), false, false, "p2");

        assert!(matches!(
            book.on_dial_result(&key, serial_of(&redial), Ok("http://127.0.0.1:42000")),
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
    }

    #[test]
    fn r9_the_local_child_is_reused_and_shutdown_takes_a_held_slot() {
        let mut book = SlotBook::default();
        let (key, dial) = acquire(&mut book, LOCAL_SLOT, local(), lease("l1"));

        ready(&mut book, &key, &dial);

        assert_eq!(
            book.hold_primary(&key, local(), true, false, "p").1,
            Action::Reuse
        );
        assert_eq!(book.drain().len(), 1);
        assert!(book.slot(&key).is_none());
    }

    #[test]
    fn r10_dropping_a_connection_ends_its_leased_slots() {
        let mut book = SlotBook::default();
        let (a, dial_a) = acquire(&mut book, "conn:a::default", ssh("a"), lease("l1"));
        let (b, dial_b) = acquire(&mut book, "conn:b::default", ssh("b"), lease("l2"));

        ready(&mut book, &a, &dial_a);
        ready(&mut book, &b, &dial_b);

        assert_eq!(
            book.drop_connection("a"),
            vec![(a.clone(), Action::Teardown)]
        );
        assert!(book.slot(&a).is_none());
        assert!(book.slot(&b).is_some());
    }

    #[test]
    fn a_failed_first_dial_ends_the_slot_instead_of_looping() {
        let mut book = SlotBook::default();
        let (key, dial) = acquire(&mut book, "conn:a::default", ssh("a"), lease("l1"));

        assert_eq!(
            book.on_dial_result(&key, serial_of(&dial), Err(FailureKind::Transient)),
            Action::Teardown
        );
        assert!(book.slot(&key).is_none());
    }
}
