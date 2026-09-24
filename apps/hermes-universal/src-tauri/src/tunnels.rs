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

    /// The terminal failures only a person can fix: an unlock, a credential, a
    /// host key to verify. Asking again in the background burns the server's
    /// auth attempts and raises the same warning, so the book allows one such
    /// dial (`SlotBook::needs_person`).
    pub fn needs_person(self) -> bool {
        matches!(
            self,
            Self::Locked | Self::CredentialsNeeded | Self::HostKeyChanged
        )
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
#[derive(Debug, Clone)]
pub struct InFlight {
    pub serial: u64,
    pub interactive: bool,
    pub attempt_id: String,
    /// Created with the dial and cancelled under the book lock when a newer dial
    /// supersedes it, so the cancel never depends on when the dial's own task
    /// got round to registering its attempt.
    pub cancel: tokio_util::sync::CancellationToken,
}

impl PartialEq for InFlight {
    fn eq(&self, other: &Self) -> bool {
        self.serial == other.serial
            && self.interactive == other.interactive
            && self.attempt_id == other.attempt_id
    }
}

impl Eq for InFlight {}

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
    /// The serial this slot's dials start from: its first dial, or the retarget
    /// that made it a different backend. A caller from before it belongs to a
    /// slot, or a target, that is gone.
    pub origin: u64,
    /// Whether the request that set `origin` was the primary's. A newer PRIMARY
    /// attempt publishes its own result, so the caller it displaced can fail
    /// quietly; a lease's does not, so that caller must resolve its own UI.
    pub origin_primary: bool,
    /// The highest serial a newer dial of this slot superseded. One number, not
    /// a set: serials are globally monotonic, so every dial of this slot at or
    /// below it has been replaced. Dies with the slot.
    pub superseded_max: u64,
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
            origin: 0,
            origin_primary: false,
            superseded_max: 0,
        }
    }

    fn unheld(&self) -> bool {
        !self.primary && self.holders.is_empty()
    }
}

/// What a caller does with a dial that ended while the key moved on.
///
/// Invariant 28: a primary caller whose dial the key no longer belongs to never
/// tears that key down, never takes a hold it was not given, and never leaves
/// the UI unresolved. It JOINS the key's current dial when the key still serves
/// its target under a newer primary attempt; it fails QUIETLY — carrying the
/// `Quiet` witness, releasing nothing — when a newer primary attempt pointed the
/// key elsewhere, because that attempt publishes; it fails with ITS OWN kind, so
/// its caller tears down as usual, when a lease owns the key now. No verdict
/// writes book state, and no caller can forge the quiet signal. A release with
/// no hold to release does nothing. Only a removal with no re-creation, a quit,
/// or the explicit hard stop `stop_slot` (the tray's Keep Running off and
/// `local_backend_kill`) ends a hold AND ITS SLOT.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// Wait for the key's current dial and adopt what it installs.
    Join,
    /// Fail with the caller's own kind; its JS tears down as usual.
    Fail,
    /// Fail quietly, releasing nothing: a newer primary attempt owns this
    /// connection and publishes its own result.
    Quiet,
}

/// The right to fail quietly, minted only on a `Verdict::Quiet`.
///
/// The field is private, so no module outside `tunnels` can build one, and
/// carrying it by value into `SshError::quiet` is the only way an error reaches
/// JS with the quiet flag set. The signal is a capability, not a kind: a failure
/// that is genuinely the caller's own — `settle_scope`'s stale `Superseded`,
/// say — can never be mistaken for it, whatever kind it was classified as. The
/// same "only the owner mints the token" shape as `InFlight.cancel` and the page
/// epoch.
#[derive(Debug, Clone)]
pub struct Quiet(());

/// What the witness is worth on the wire: `"quiet": true`, or no key at all.
impl serde::Serialize for Quiet {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_bool(true)
    }
}

#[cfg(test)]
impl Quiet {
    /// A witness for a test that cannot reach `join_dial`, which needs a running
    /// `AppHandle`. Test-only: no production path outside this module mints one.
    pub(crate) fn for_test() -> Self {
        Self(())
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
    /// A background request for a connection whose last dial needs a person:
    /// dial nothing, hold nothing, and fail as that dial did.
    Refuse {
        kind: FailureKind,
    },
}

/// A dial that ended on something only a person can fix.
#[derive(Debug, Clone)]
pub struct NeedsPerson {
    pub kind: FailureKind,
    /// The target that dial was for. Another target has not failed yet.
    pub fingerprint: String,
    /// The error and the status that dial published, which a refusal repeats
    /// word for word. The runtime's to fill: the book decides on the kind alone.
    pub published: Option<(TunnelError, TunnelStatus)>,
}

#[derive(Debug, Default)]
pub struct SlotBook {
    slots: BTreeMap<String, Slot>,
    /// Each live window's page epoch. A page opening takes a new one; a destroyed
    /// window loses it. A hold carries the epoch its page opened under, so one
    /// issued by a page that is already gone is refused instead of outliving it.
    epochs: HashMap<String, u64>,
    /// Where epochs come from: book-wide and never reset, so a recreated window
    /// (session-tile labels are deterministic) never reissues a gone page's epoch.
    epoch_counter: u64,
    /// Set once at exit, under the book lock: nothing starts after it.
    quitting: bool,
    /// Serials are unique across the book, so a recreated slot can never
    /// credit a dial that belonged to its predecessor.
    serial: u64,
    /// The background budget: ONE dial per (connection, target) that ends on
    /// something only a person can fix (`FailureKind::needs_person`). By
    /// connection id and OUTSIDE the slots, because the slot such a dial fails
    /// in usually leaves with it (`on_dial_result`, `release_primary`).
    ///
    ///  * Set by a CREDITED result alone, so once per dial: a joiner waits on
    ///    that dial's outcome and settles nothing, and a stale or superseded
    ///    dial's result is not the slot's to record.
    ///  * While it stands, a background request that would DIAL is refused
    ///    (`Action::Refuse`) and writes nothing — no slot, no holder, no primary
    ///    hold, no serial — so the refcount, the linger, the reaper and the
    ///    generation never see it. One that dials nothing is served as ever
    ///    (`Reuse`, `Join`).
    ///  * A person's DIAL ends it, by its result. An interactive request is
    ///    never refused and clears nothing: it dials, and a background request
    ///    arriving meanwhile joins that dial. Landing ends the budget; needing a
    ///    person again records the new failure over the old; anything else — a
    ///    dismissed prompt, a network blip — leaves it standing, so it costs no
    ///    further background attempt.
    ///  * A person changing something ends it outright: a restart, a save of
    ///    the connection, a request for a different fingerprint, a dropped
    ///    connection.
    ///  * A transient failure never sets it, and Rust's own redial loop never
    ///    meets it: nothing turns `Retrying` while it stands.
    ///  * In memory only: a new process has a new budget.
    needs_person: HashMap<String, NeedsPerson>,
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

    /// What stops background dials of `connection_id`, if anything does.
    pub fn needs_person(&self, connection_id: &str) -> Option<&NeedsPerson> {
        self.needs_person.get(connection_id)
    }

    /// A person acted on `connection_id` outside a dial — they saved it — so
    /// the next background dial is one they asked for.
    pub fn person_acted(&mut self, connection_id: &str) {
        self.needs_person.remove(connection_id);
    }

    /// What the runtime published for the failure `on_dial_result` just
    /// recorded. Once: a later result that records nothing changes nothing.
    pub fn publish_needs_person(
        &mut self,
        connection_id: &str,
        error: &TunnelError,
        status: TunnelStatus,
    ) {
        if let Some(entry) = self.needs_person.get_mut(connection_id) {
            entry
                .published
                .get_or_insert_with(|| (error.clone(), status));
        }
    }

    /// A request for a target other than the one that failed ends the budget:
    /// the connection was edited.
    fn admit(&mut self, spec: &SlotSpec) {
        let ended = self
            .needs_person
            .get(&spec.connection_id)
            .is_some_and(|entry| entry.fingerprint != spec.fingerprint);

        if ended {
            self.needs_person.remove(&spec.connection_id);
        }
    }

    /// The refusal a BACKGROUND request that would dial gets instead; a person
    /// asking is never refused. Asked after `admit`, so whatever still stands is
    /// this target's.
    fn refuse(&self, connection_id: &str, interactive: bool) -> Option<Action> {
        self.needs_person
            .get(connection_id)
            .filter(|_| !interactive)
            .map(|entry| Action::Refuse { kind: entry.kind })
    }

    /// Whether the budget stands over `spec`, so nothing may dial it unasked.
    fn stands(ledger: &HashMap<String, NeedsPerson>, spec: &SlotSpec) -> bool {
        ledger
            .get(&spec.connection_id)
            .is_some_and(|entry| entry.fingerprint == spec.fingerprint)
    }

    fn begin(&mut self, key: &str, interactive: bool, attempt_id: &str, primary: bool) -> u64 {
        self.serial += 1;

        let serial = self.serial;
        let slot = self
            .slots
            .get_mut(key)
            .expect("a slot being dialled exists");

        slot.phase = Phase::Connecting;

        if slot.origin == 0 {
            slot.origin = serial;
            slot.origin_primary = primary;
        }

        slot.dial = Some(InFlight {
            serial,
            interactive,
            attempt_id: attempt_id.to_string(),
            cancel: tokio_util::sync::CancellationToken::new(),
        });

        serial
    }

    /// Take the slot's in-flight dial to supersede it, cancelling it here, under
    /// the book lock, and remember it was superseded rather than removed.
    fn supersede(slot: &mut Slot) -> Option<InFlight> {
        let previous = slot.dial.take();

        if let Some(previous) = &previous {
            previous.cancel.cancel();
            slot.superseded_max = slot.superseded_max.max(previous.serial);
        }

        previous
    }

    /// Whether a newer dial of the same slot took dial `serial`'s place — so its
    /// caller waits for that dial instead of failing.
    ///
    /// True when the slot superseded it, and when the slot is dialling something
    /// newer: a dial that failed on its own a moment before a newer one began
    /// was never recorded, and failing its caller would remove the slot and
    /// cancel that newer dial. False once the slot is removed (or quit drained
    /// it), on a slot re-created at the key, and for a caller from before a
    /// retarget — that dial asked for a different backend.
    pub fn superseded(&self, key: &str, serial: u64) -> bool {
        let Some(slot) = self.slots.get(key) else {
            return false;
        };

        if serial < slot.origin {
            return false;
        }

        serial <= slot.superseded_max || slot.dial.as_ref().is_some_and(|dial| dial.serial > serial)
    }

    /// Who the key belongs to now, for a caller whose dial `serial` has ended.
    /// Asked by the primary's dial alone; a lease never joins (invariant 28).
    ///
    /// WHO moved the origin decides first: only a newer PRIMARY attempt holds
    /// the key, so only it leaves something this caller may adopt or trust to
    /// publish. Under it, the FINGERPRINT decides join or quiet: may this caller
    /// adopt what the key serves now? A lease owns nothing on this caller's
    /// behalf, so the caller fails with its own kind and resolves its own UI.
    ///
    /// `&self`: a verdict is not a hold. It answers whose key this is and
    /// writes nothing — `slot.primary` belongs to `hold_primary` and
    /// `release_primary`, the only two that can end what they began.
    pub fn join(&self, key: &str, serial: u64, fingerprint: &str) -> Verdict {
        let Some(slot) = self.slots.get(key) else {
            return Verdict::Fail;
        };

        // Still this caller's slot: it joins only a newer dial of it.
        if self.superseded(key, serial) {
            return Verdict::Join;
        }

        if serial >= slot.origin {
            return Verdict::Fail;
        }

        // Older than the origin: the key was retargeted or re-created under it.
        match (slot.origin_primary, slot.spec.fingerprint == fingerprint) {
            // The key still serves what this caller asked for, under a newer
            // primary attempt that took the hold and owns its release.
            (true, true) => Verdict::Join,
            // That attempt pointed the key elsewhere: it publishes its own
            // result, so this caller says nothing and releases nothing.
            (true, false) => Verdict::Quiet,
            // A lease owns the key now, whatever it points at: its holder keeps
            // the slot through this caller's release, and `primary` stays false
            // so the slot goes when that lease does.
            (false, _) => Verdict::Fail,
        }
    }

    /// What an existing slot does for a request (a lease or the primary).
    fn request(
        &mut self,
        key: &str,
        spec: SlotSpec,
        alive: bool,
        interactive: bool,
        attempt_id: &str,
        primary: bool,
    ) -> Action {
        let refuse = self.refuse(&spec.connection_id, interactive);
        let slot = self.slots.get_mut(key).expect("a requested slot exists");

        // A different target at the same key is a different backend: never
        // reuse it, and end the leases that were riding the old one.
        if slot.spec.fingerprint != spec.fingerprint {
            if let Some(refuse) = refuse {
                return refuse;
            }

            let previous = Self::supersede(slot);

            slot.spec = spec;
            slot.holders.clear();
            slot.base_url = None;
            slot.failure = None;

            let serial = self.begin(key, interactive, attempt_id, primary);

            // A caller from before the retarget asked for a different backend,
            // and who retargeted decides whether it may stay quiet about it.
            let slot = self.slots.get_mut(key).expect("the retargeted slot exists");

            slot.origin = serial;
            slot.origin_primary = primary;

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
                    let previous = Self::supersede(slot);
                    let serial = self.begin(key, interactive, attempt_id, primary);

                    Action::Supersede {
                        serial,
                        previous,
                        retarget: false,
                    }
                }
                _ => Action::Join,
            },
            _ => refuse.unwrap_or_else(|| Action::Dial {
                serial: self.begin(key, interactive, attempt_id, primary),
            }),
        }
    }

    /// A lease joins the connection's live slot, or creates one at `key`.
    ///
    /// `None`, with nothing inserted, when `page_epoch` is not the holder
    /// window's current epoch: the page that asked has reloaded or its window is
    /// gone, and no lifecycle event would ever end the hold.
    pub fn acquire(
        &mut self,
        key: &str,
        spec: SlotSpec,
        holder: Holder,
        interactive: bool,
        attempt_id: &str,
        page_epoch: u64,
    ) -> Option<(String, Action)> {
        if self.quitting || self.epochs.get(&holder.window) != Some(&page_epoch) {
            return None;
        }

        self.admit(&spec);

        let key = self
            .key_for(&spec.connection_id)
            .unwrap_or_else(|| key.to_string());

        let action = if self.slots.contains_key(&key) {
            self.request(&key, spec, true, interactive, attempt_id, false)
        } else if let Some(refuse) = self.refuse(&spec.connection_id, interactive) {
            refuse
        } else {
            self.slots.insert(key.clone(), Slot::new(spec));

            Action::Dial {
                serial: self.begin(&key, interactive, attempt_id, false),
            }
        };

        // A refusal holds nothing.
        if matches!(action, Action::Refuse { .. }) {
            return Some((key, action));
        }

        let slot = self.slots.get_mut(&key).expect("the acquired slot exists");

        slot.holders.insert(holder);
        slot.unheld_since = None;

        Some((key, action))
    }

    /// The active connection's own dial. `alive` is the caller's liveness read
    /// of what the slot holds: a ready slot whose session died is redialled,
    /// never reused — and never closed while it is still serving someone.
    /// `None` once the app is quitting.
    pub fn hold_primary(
        &mut self,
        key: &str,
        spec: SlotSpec,
        alive: bool,
        interactive: bool,
        attempt_id: &str,
    ) -> Option<(String, Action)> {
        if self.quitting {
            return None;
        }

        self.admit(&spec);

        let key = self
            .key_for(&spec.connection_id)
            .unwrap_or_else(|| key.to_string());

        let action = if self.slots.contains_key(&key) {
            self.request(&key, spec, alive, interactive, attempt_id, true)
        } else if let Some(refuse) = self.refuse(&spec.connection_id, interactive) {
            refuse
        } else {
            self.slots.insert(key.clone(), Slot::new(spec));

            Action::Dial {
                serial: self.begin(&key, interactive, attempt_id, true),
            }
        };

        // A refusal holds nothing.
        if matches!(action, Action::Refuse { .. }) {
            return Some((key, action));
        }

        let slot = self.slots.get_mut(&key).expect("the held slot exists");

        slot.primary = true;
        slot.unheld_since = None;

        Some((key, action))
    }

    /// Leaving the active connection. `None` when there was no slot at all.
    ///
    /// A release with no hold to release does nothing (invariant 28): a caller
    /// the key has moved on from — one the verdict failed, or a second release
    /// after the first — must not remove a slot a lease owns, nor cancel a dial
    /// from that lease's era. The slot leaves on the lease's own linger.
    pub fn release_primary(&mut self, key: &str) -> Option<Action> {
        let slot = self.slots.get_mut(key)?;

        if !std::mem::replace(&mut slot.primary, false) {
            return Some(Action::None);
        }

        if slot.holders.is_empty() {
            self.remove_slot(key);

            return Some(Action::Teardown);
        }

        // The primary owned the retries while it held the slot. Hand a dead,
        // retryable slot to the Rust loop now that leases are all that is left —
        // unless it needs a person, whose dial failing on the network changed
        // nothing about that.
        if slot.phase == Phase::Failed
            && !slot.failure.is_some_and(FailureKind::is_terminal)
            && !Self::stands(&self.needs_person, &slot.spec)
        {
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

    /// The page in `label` declares its own start (`tunnel_page_open`): it takes a
    /// new epoch from the book-wide counter, and every hold an earlier page of the
    /// window took ends. `None`, changing nothing, once the app is quitting.
    pub fn page_open(&mut self, label: &str, now: u64) -> Option<u64> {
        if self.quitting {
            return None;
        }

        self.epoch_counter += 1;

        let epoch = self.epoch_counter;

        self.epochs.insert(label.to_string(), epoch);
        self.reap_window(label, now);

        Some(epoch)
    }

    /// A page load started in `label` (desktop only): a reap-only backstop. The
    /// epoch is the page's own to move, through `page_open`.
    pub fn page_started(&mut self, label: &str, now: u64) -> Vec<String> {
        self.reap_window(label, now)
    }

    /// `label` was destroyed: its holds end and no epoch is current for it.
    pub fn window_destroyed(&mut self, label: &str, now: u64) {
        self.epochs.remove(label);
        self.reap_window(label, now);
    }

    /// The epoch a page in `label` holds tunnels under, if the window is live.
    #[cfg(test)]
    pub fn page_epoch(&self, label: &str) -> Option<u64> {
        self.epochs.get(label).copied()
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
            self.remove_slot(key);
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
            self.remove_slot(key);

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
                self.needs_person.remove(&slot.spec.connection_id);

                Action::Ready {
                    generation: slot.generation,
                }
            }

            Err(kind) => {
                slot.failure = Some(kind);

                // Recorded before the slot can leave with its spec. Any other
                // failure leaves a standing budget as it was: a dismissed
                // prompt or a network blip answered nothing.
                if kind.needs_person() {
                    self.needs_person.insert(
                        slot.spec.connection_id.clone(),
                        NeedsPerson {
                            kind,
                            fingerprint: slot.spec.fingerprint.clone(),
                            published: None,
                        },
                    );
                }

                // A lease whose FIRST dial fails gets the error, not a retry
                // loop it never saw succeed.
                if slot.unheld() || (slot.generation == 0 && !slot.primary) {
                    self.remove_slot(key);

                    return Action::Teardown;
                }

                // The redial loop is a background dial too: it stays out of a
                // slot that still needs a person.
                if slot.primary
                    || kind.is_terminal()
                    || Self::stands(&self.needs_person, &slot.spec)
                {
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

        if self.quitting
            || slot.phase != Phase::Retrying
            || slot.attempt != attempt
            || slot.primary
            || slot.holders.is_empty()
        {
            return None;
        }

        Some(self.begin(key, false, attempt_id, slot.primary))
    }

    /// "Restart backend": the explicit respawn, keeping every holder. A restart
    /// during a dial supersedes that dial once it has drained.
    pub fn restart(&mut self, key: &str, attempt_id: &str) -> Action {
        let Some(slot) = self.slots.get_mut(key) else {
            return Action::None;
        };

        let primary = slot.primary;
        let previous = Self::supersede(slot);

        // A person asked for it.
        self.needs_person.remove(&slot.spec.connection_id);

        let serial = self.begin(key, true, attempt_id, primary);

        match previous {
            Some(previous) => Action::Supersede {
                serial,
                previous: Some(previous),
                retarget: false,
            },
            None => Action::Dial { serial },
        }
    }

    /// A connection was edited (dial fields) or removed. Its leases end, and so
    /// does its background budget; a slot the primary still holds stays until
    /// the primary lets it go or redials a new target.
    pub fn drop_connection(&mut self, connection_id: &str) -> Vec<(String, Action)> {
        self.needs_person.remove(connection_id);

        self.slots_for(connection_id)
            .into_iter()
            .map(|key| {
                let slot = self.slots.get_mut(&key).expect("key was just listed");

                slot.holders.clear();

                if slot.primary {
                    (key, Action::None)
                } else {
                    self.remove_slot(&key);

                    (key, Action::Teardown)
                }
            })
            .collect()
    }

    /// The one way a slot leaves the book: its in-flight dial, if any, is
    /// cancelled here, under the book lock, so no removal leaves an orphaned dial
    /// running beside a successor at the same key.
    pub fn remove_slot(&mut self, key: &str) -> Option<Slot> {
        let slot = self.slots.remove(key)?;

        if let Some(dial) = &slot.dial {
            dial.cancel.cancel();
        }

        Some(slot)
    }

    /// Exit: nothing starts from here on, and every slot leaves the book.
    pub fn quit(&mut self) -> Vec<(String, Slot)> {
        self.quitting = true;

        let keys: Vec<String> = self.slots.keys().cloned().collect();

        keys.into_iter()
            .filter_map(|key| self.remove_slot(&key).map(|slot| (key, slot)))
            .collect()
    }
}

/// A verdict reads the book and never writes it (invariant 28). Pinned as a
/// `fn` over `&SlotBook`, so a branch that re-asserted the primary's hold —
/// which left a hold nobody owned, and a slot nothing could reap — would not
/// compile.
const _: fn(&SlotBook, &str, u64, &str) -> Verdict = SlotBook::join;

/// Whether a webview's page keeps a tunnel epoch: only a window's own webview.
/// Holders are keyed by the window label, and a guest webview (MJXHRM-447) is
/// never destroyed under a label the book would ever remove.
pub fn records_epoch(webview_label: &str, window_label: &str) -> bool {
    webview_label == window_label
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
#[cfg(desktop)]
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
    /// The SSH failure this came from, so the UI picks the same localized copy
    /// the configurator shows. Additive; absent for a failure outside SSH.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssh_kind: Option<SshErrorKind>,
}

impl TunnelError {
    pub fn new(kind: FailureKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            terminal: kind.is_terminal(),
            ssh_kind: None,
        }
    }

    pub fn from_ssh(error: &crate::ssh::error::SshError) -> Self {
        Self {
            ssh_kind: Some(error.kind),
            ..Self::new(FailureKind::from_ssh(error.kind), error.message.clone())
        }
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
    /// This dial's cancel token; its SSH attempt adopts it.
    pub cancel: tokio_util::sync::CancellationToken,
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

/// The status a dial's failure is published as, whether its slot stays or
/// leaves — and the one a refusal repeats (`SlotBook::needs_person`).
fn failed_status(spec: &SlotSpec, generation: u64, error: &TunnelError) -> TunnelStatus {
    TunnelStatus {
        connection_id: spec.connection_id.clone(),
        phase: StatusPhase::Failed,
        error_kind: Some(error.kind),
        message: Some(error.message.clone()),
        terminal: error.terminal,
        generation,
        instance_key: spec.instance_key.clone(),
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
    let cancel = inner
        .book
        .slot(&key)
        .and_then(|slot| slot.dial.as_ref())
        .map(|dial| dial.cancel.clone())
        .unwrap_or_default();

    Dial {
        key,
        serial,
        cancel,
        outcome,
        previous,
        retarget,
    }
}

/// Turn a book request for `key` into what the caller does. Under the lock.
fn hold_for(
    app: &AppHandle,
    inner: &mut Inner,
    key: String,
    connection_id: &str,
    action: Action,
) -> Result<Hold, TunnelError> {
    Ok(match action {
        Action::Reuse => Hold::Reuse(key),
        Action::Dial { serial } => Hold::Dial(begun(app, inner, key, serial, None, false)),
        Action::Supersede {
            serial,
            previous,
            retarget,
        } => Hold::Dial(begun(app, inner, key, serial, previous, retarget)),
        Action::Refuse { kind } => {
            let (error, status) = refused(inner, connection_id, kind);

            if let Some(status) = &status {
                emit_status(app, status);
            }

            return Err(error);
        }
        _ => {
            let rx = signal(inner, &key).subscribe();

            Hold::Join(key, rx)
        }
    })
}

/// A background request the book refused fails as the dial it stands in for
/// did: that dial's error, and that dial's status for the UI that raises the
/// sign-in and host-key warnings from it. Nothing that dial did not publish.
fn refused(
    inner: &Inner,
    connection_id: &str,
    kind: FailureKind,
) -> (TunnelError, Option<TunnelStatus>) {
    inner
        .book
        .needs_person(connection_id)
        .and_then(|entry| entry.published.clone())
        .map(|(error, status)| (error, Some(status)))
        .unwrap_or_else(|| {
            (
                TunnelError::new(kind, "this connection needs a person"),
                None,
            )
        })
}

/// Wait out a superseded dial, and drop a retargeted slot's old resources,
/// before running this one.
pub(crate) async fn prepare(app: &AppHandle, dial: &mut Dial, kind: SlotKind) {
    // The superseded dial's token was cancelled when the book superseded it; all
    // that is left is to let it drain.
    if let Some((_previous, drained)) = dial.previous.take() {
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

/// What a caller does with a dial that ended: the book's verdict, with the
/// successor's outcome subscribed in the same section as the check.
pub(crate) enum Joined {
    /// Wait for this, then read what the key installed.
    Successor(watch::Receiver<Outcome>),
    /// Fail with the caller's own error, whatever kind it carries.
    Fail,
    /// Fail quietly: a newer primary attempt owns this connection and publishes
    /// its own result. The witness is what marks the error quiet for JS.
    Quiet(Quiet),
}

/// Who the key belongs to now, for a caller whose dial ended. Asked by the
/// primary's dial alone, and it takes no hold: the successor it joins is the
/// attempt that already holds the key (invariant 28).
pub(crate) fn join_dial(app: &AppHandle, key: &str, serial: u64, fingerprint: &str) -> Joined {
    locked(app, |inner| {
        match inner.book.join(key, serial, fingerprint) {
            Verdict::Join => Joined::Successor(signal(inner, key).subscribe()),
            Verdict::Fail => Joined::Fail,
            Verdict::Quiet => Joined::Quiet(Quiet(())),
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

/// A slot left the book: its waiters settle `Failed`, never left pending.
fn settle_closed(inner: &mut Inner, key: &str, error: Option<&TunnelError>) {
    if let Some(tx) = inner.signals.remove(key) {
        tx.send_replace(Outcome::Failed(error.cloned().unwrap_or_else(|| {
            TunnelError::new(FailureKind::Transient, "the tunnel was closed")
        })));
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
    settle_closed(inner, key, error);

    let status = match error {
        Some(error) => failed_status(&before.spec, before.generation, error),
        None => status_of(before, StatusPhase::Closed, None),
    };

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

pub(crate) async fn teardown(app: &AppHandle, key: &str, kind: SlotKind) {
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
        SlotKind::Local => {
            let _ = crate::local_backend::kill_child(app, false).await;
        }
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

/// The active connection's hold. Refused once the app is quitting.
pub(crate) fn hold_primary(
    app: &AppHandle,
    key: &str,
    spec: SlotSpec,
    alive: bool,
    interactive: bool,
    attempt_id: &str,
) -> Result<Hold, TunnelError> {
    locked(app, |inner| {
        let connection_id = spec.connection_id.clone();
        let (key, action) = inner
            .book
            .hold_primary(key, spec, alive, interactive, attempt_id)
            .ok_or_else(quitting)?;

        hold_for(app, inner, key, &connection_id, action)
    })
}

/// A connection was saved: a person acted on it, whatever they changed.
pub(crate) fn person_acted(app: &AppHandle, connection_id: &str) {
    locked(app, |inner| inner.book.person_acted(connection_id));
}

fn quitting() -> TunnelError {
    TunnelError::new(FailureKind::Unavailable, "the app is quitting")
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

        if let (Some(slot), Err(error)) = (&before, &result) {
            if action != Action::Stale && error.kind.needs_person() {
                log::info!(
                    "[tunnel] {} needs a person; background dials wait for one",
                    slot.spec.connection_id
                );
                inner.book.publish_needs_person(
                    &slot.spec.connection_id,
                    error,
                    failed_status(&slot.spec, slot.generation, error),
                );
            }
        }

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
    dial: Dial,
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
        // So does the local dial, racing its cancel through every step.
        SlotKind::Local => crate::local_backend::dial_tunnel(app, dial).await,
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

/// Drop a slot regardless of its holders, returning its teardown.
fn remove_slot(app: &AppHandle, key: &str) -> Option<Effect> {
    locked(app, |inner| {
        let slot = inner.book.remove_slot(key)?;

        Some(closed(app, inner, key, &slot, None))
    })
}

/// A hard stop (the tray, `local_backend_kill`): the slot goes whoever holds
/// it, and its resources go through the teardown under the install lock. With
/// no slot the teardown still runs: a start or a child may exist outside it.
pub(crate) async fn stop_slot(app: &AppHandle, key: &str, kind: SlotKind) {
    let effect = remove_slot(app, key).unwrap_or(Effect::Teardown {
        key: key.to_string(),
        kind,
    });

    apply(app, vec![effect]).await;
}

/// Every slot key a connection currently has. For MJXHRM-528's drain, which is
/// its first caller.
#[allow(dead_code)]
pub(crate) fn slots_for(app: &AppHandle, connection_id: &str) -> Vec<String> {
    locked(app, |inner| inner.book.slots_for(connection_id))
}

/// `PageLoadEvent::Started`, desktop only: the old page's leases end (a slot it
/// alone held lingers one reaper tick). A reap-only backstop — the epoch moves
/// only when the new page opens (`tunnel_page_open`).
#[cfg(desktop)]
pub fn page_started(app: &AppHandle, label: &str) {
    locked(app, |inner| {
        inner.book.page_started(label, now_ms());
    });
}

/// `WindowEvent::Destroyed`: the window's leases end and its epoch is gone.
pub fn window_destroyed(app: &AppHandle, label: &str) {
    locked(app, |inner| {
        inner.book.window_destroyed(label, now_ms());
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
    /// Kill the local child, whether or not a slot holds it, keeping its drains.
    KillLocal,
    /// Wait for the killed child's pipe drains, which may still be reading its
    /// last lines. Bounded by the log deadline it shares with `CloseLog`.
    AwaitDrains,
    /// Close the local backend's log and wait, briefly, for its writer: managed
    /// state is never dropped at exit, so nothing else flushes it.
    CloseLog,
    /// Close an SSH scope's session. Bounded by the shared close deadline.
    CloseSsh(String),
}

/// The exit order: the local child first, its drains, its log, then every SSH
/// close. A hanging SSH close runs into its deadline; it must never stand
/// between the app and the kill that keeps `hermes serve` from outliving it.
pub fn shutdown_plan(slots: &[(String, SlotKind)]) -> Vec<ShutdownStep> {
    [
        ShutdownStep::KillLocal,
        ShutdownStep::AwaitDrains,
        ShutdownStep::CloseLog,
    ]
    .into_iter()
    .chain(
        slots
            .iter()
            .filter(|(_, kind)| *kind == SlotKind::Ssh)
            .map(|(key, _)| ShutdownStep::CloseSsh(key.clone())),
    )
    .collect()
}

/// How long the killed child's drains and the log writer get, together.
pub const LOG_DEADLINE: Duration = Duration::from_millis(500);

/// `RunEvent::Exit`: runs `shutdown_plan` in its order.
pub fn shutdown(app: &AppHandle) {
    // Under the book lock: nothing starts after this, every slot's dial is
    // cancelled and its waiters settle `Failed`.
    let slots: Vec<(String, SlotKind)> = locked(app, |inner| {
        let removed = inner.book.quit();

        for (key, _) in &removed {
            settle_closed(inner, key, None);
        }

        inner.signals.clear();

        removed
            .into_iter()
            .map(|(key, slot)| (key, slot.spec.kind))
            .collect()
    });

    let app = app.clone();

    tauri::async_runtime::block_on(async move {
        // A session close sends a disconnect; a dead network must not hold the
        // process open, so all the closes share one deadline.
        let mut deadline = None;
        let mut drains = Vec::new();
        let log_until = tokio::time::Instant::now() + LOG_DEADLINE;

        for step in shutdown_plan(&slots) {
            match step {
                ShutdownStep::KillLocal => {
                    drains = crate::local_backend::kill_child(&app, true).await
                }
                ShutdownStep::AwaitDrains => {
                    crate::backend_log::await_drains(std::mem::take(&mut drains), log_until).await
                }
                ShutdownStep::CloseLog => crate::local_backend::close_log(&app, log_until),
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
    page_epoch: Option<u64>,
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

    let acquired = locked(&app, |inner| {
        if installation_id.is_some() {
            inner.installation_id = installation_id.clone();
        }

        let (key, action) =
            inner
                .book
                .acquire(&key, spec, holder, interactive, &attempt_id, page_epoch?)?;

        Some(
            hold_for(&app, inner, key.clone(), &connection_id, action).map(|hold| {
                let spec = inner
                    .book
                    .slot(&key)
                    .expect("an acquired slot exists")
                    .spec
                    .clone();

                (hold, spec, inner.installation_id.clone())
            }),
        )
    });

    let Some(acquired) = acquired else {
        return Err(TunnelError::new(
            FailureKind::Unavailable,
            "this page no longer holds tunnels",
        ));
    };
    let (hold, spec, installation_id) = acquired?;

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

    // Invariant 26 for a lease: this caller never fails a dial that a newer one
    // replaced, because it waits on the SLOT's signal — subscribed in `begun`,
    // under the same book section that began the dial — and only a current dial
    // ever settles that signal. A refactor that returned this dial's own result
    // instead would have to call `join_dial`, as the primary paths do.
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

/// The page declares its own start and gets the epoch its holds carry: every
/// hold an earlier page of this window took ends, under the book lock.
///
/// SYNCHRONOUS on purpose: Tauri runs a sync command inline in the IPC handler,
/// so it is FIFO with this webview's other IPC — on Android too, where
/// `onPageStarted` and the JavaBridge thread are unordered. Refused for a guest
/// webview and once the app is quitting.
#[tauri::command]
pub fn tunnel_page_open(app: AppHandle, webview: Webview<Wry>) -> Result<u64, TunnelError> {
    let label = webview.label().to_string();
    let window = webview.window().label().to_string();

    locked(&app, |inner| {
        if !records_epoch(&label, &window) {
            return Err(TunnelError::new(
                FailureKind::Unavailable,
                "this webview does not hold tunnels",
            ));
        }

        inner.book.page_open(&label, now_ms()).ok_or_else(quitting)
    })
}

/// Compile guard: `tunnel_page_open` stays a plain `fn`. Made `async`, it would
/// run on the async runtime, out of order with the page's other IPC.
const _: fn(AppHandle, Webview<Wry>) -> Result<u64, TunnelError> = tunnel_page_open;

#[tauri::command]
pub async fn tunnel_status(app: AppHandle, connection_id: String) -> Option<TunnelStatus> {
    locked(&app, |inner| {
        let key = inner.book.key_for(&connection_id)?;
        let slot = inner.book.slot(&key)?;

        Some(status_of(slot, phase_of(slot), None))
    })
}

/// Live gateway base URL for a connection, if its tunnel is up.
pub fn base_url_for(app: &AppHandle, connection_id: &str) -> Option<String> {
    locked(app, |inner| {
        let key = inner.book.key_for(connection_id)?;
        let slot = inner.book.slot(&key)?;
        slot.base_url.clone()
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

    /// A book whose test windows each have an open page: `main` at epoch 1.
    fn pages() -> SlotBook {
        let mut book = SlotBook::default();

        book.page_open("main", 0);
        book.page_open("session-x", 0);

        book
    }

    /// The lifecycle model's state invariants, checked after every transition.
    fn assert_model(book: &SlotBook) {
        for (key, slot) in &book.slots {
            // 1: a holder only while its window has a live epoch.
            for holder in &slot.holders {
                assert!(
                    book.epochs.contains_key(&holder.window),
                    "{key}: holder {holder:?} outlived its page"
                );
            }

            // 5: no holderless slot — held, primary, or lingering.
            assert!(
                !slot.unheld() || slot.unheld_since.is_some(),
                "{key}: unheld and not lingering"
            );

            // 6: a Connecting slot has exactly one dial, and nothing else has one.
            assert_eq!(
                slot.phase == Phase::Connecting,
                slot.dial.is_some(),
                "{key}: phase {:?} with dial {:?}",
                slot.phase,
                slot.dial
            );
        }
    }

    fn token_serial(book: &SlotBook, key: &str) -> u64 {
        book.slot(key)
            .and_then(|slot| slot.dial.as_ref())
            .expect("a dial is in flight")
            .serial
    }

    fn token(book: &SlotBook, key: &str) -> tokio_util::sync::CancellationToken {
        book.slot(key)
            .and_then(|slot| slot.dial.as_ref())
            .expect("a dial is in flight")
            .cancel
            .clone()
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
        let epoch = book.page_epoch(&holder.window).expect("the page is open");

        book.acquire(key, spec, holder, false, "tunnel-x", epoch)
            .expect("a live page acquires")
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
        let mut book = pages();

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
        let mut book = pages();
        let (key, dial) = acquire(&mut book, "conn:a::default", ssh("a"), lease("l1"));

        ready(&mut book, &key, &dial);

        // The primary asks with the scope a `work` profile used to produce.
        let (primary_key, action) = book
            .hold_primary("conn:a::work", ssh("a"), true, false, "p")
            .unwrap();

        assert_eq!(primary_key, "conn:a::default");
        assert_eq!(action, Action::Reuse);
        assert_eq!(book.slots_for("a").len(), 1);
    }

    #[test]
    fn r3_releasing_the_primary_keeps_a_leased_slot() {
        let mut book = pages();
        let (key, dial) = book
            .hold_primary("conn:a::default", ssh("a"), false, false, "p")
            .unwrap();

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
        let mut book = pages();
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
        let mut book = pages();
        let (key, first) = book
            .hold_primary(LOCAL_SLOT, local(), false, false, "p")
            .unwrap();

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
        let mut book = pages();
        let (key, dial) = book
            .hold_primary("", ssh("legacy"), false, false, "p")
            .unwrap();

        ready(&mut book, &key, &dial);
        acquire(&mut book, &key, ssh("legacy"), lease("l1"));

        let mut moved = ssh("legacy");

        moved.fingerprint = ssh_fingerprint("deploy", "box2", 22, None, None);

        let (_, action) = book
            .hold_primary("", moved.clone(), true, false, "p2")
            .unwrap();

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
        let mut book = pages();
        let (key, dial) = book
            .acquire(
                "conn:a::default",
                ssh("a"),
                lease("old-page"),
                false,
                "t",
                1,
            )
            .expect("a live page acquires");

        ready(&mut book, &key, &dial);

        assert_eq!(book.reap_window("main", 1_000), vec![key.clone()]);
        assert!(book.slot(&key).is_some(), "not torn down at once");

        let (_, again) = book
            .acquire(&key, ssh("a"), lease("new-page"), false, "t", 1)
            .expect("a live page acquires");

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
        let mut book = pages();
        let (key, dial) = book
            .acquire("conn:a::default", ssh("a"), lease("cold"), false, "t", 1)
            .expect("a live page acquires");

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
                ShutdownStep::AwaitDrains,
                ShutdownStep::CloseLog,
                ShutdownStep::CloseSsh("conn:a::default".to_string()),
                ShutdownStep::CloseSsh("conn:b::default".to_string()),
            ]
        );
        // No local slot: the child may still be running, so it is killed anyway.
        assert_eq!(
            shutdown_plan(&[]),
            vec![
                ShutdownStep::KillLocal,
                ShutdownStep::AwaitDrains,
                ShutdownStep::CloseLog
            ]
        );
    }

    #[test]
    fn d1_a_page_open_ends_the_previous_pages_holds_and_its_epoch() {
        let mut book = SlotBook::default();
        let first = book.page_open("a", 0).expect("open");
        let (key, action) = book
            .acquire(
                "conn:x::default",
                ssh("x"),
                Holder::new("a", "old"),
                false,
                "t",
                first,
            )
            .expect("the open page acquires");

        assert!(matches!(action, Action::Dial { .. }));

        // The page reloads and declares its start before its own first acquire.
        let second = book.page_open("a", 10).expect("open");

        assert!(second > first);
        assert!(
            !book
                .slot(&key)
                .unwrap()
                .holders
                .contains(&Holder::new("a", "old")),
            "the previous page's hold ended"
        );

        // A late acquire from the gone page is refused and inserts nothing.
        assert!(book
            .acquire(&key, ssh("x"), Holder::new("a", "late"), false, "t", first)
            .is_none());
        assert!(book.slot(&key).unwrap().holders.is_empty());

        assert!(book
            .acquire(&key, ssh("x"), Holder::new("a", "new"), false, "t", second)
            .is_some());
        assert_model(&book);
    }

    #[test]
    fn d1_a_recreated_window_never_reissues_an_epoch() {
        let mut book = SlotBook::default();
        let first = book.page_open("session-1", 0).expect("open");

        book.window_destroyed("session-1", 5);

        assert_eq!(book.page_epoch("session-1"), None);

        // Session-tile labels are deterministic: the same label comes back.
        let reopened = book.page_open("session-1", 10).expect("open");

        assert_ne!(reopened, first);
        assert!(book
            .acquire(
                "conn:x::default",
                ssh("x"),
                Holder::new("session-1", "late"),
                false,
                "t",
                first
            )
            .is_none());
        assert!(book.slot("conn:x::default").is_none(), "no holder, no slot");
    }

    #[cfg(desktop)]
    #[test]
    fn d1_a_page_load_start_only_reaps() {
        let mut book = SlotBook::default();
        let epoch = book.page_open("a", 0).expect("open");
        let (key, _) = book
            .acquire(
                "conn:x::default",
                ssh("x"),
                Holder::new("a", "l"),
                false,
                "t",
                epoch,
            )
            .expect("the open page acquires");

        assert_eq!(book.page_started("a", 10), vec![key.clone()]);
        assert_eq!(book.page_epoch("a"), Some(epoch), "the epoch is the page's");
        assert!(book.slot(&key).unwrap().holders.is_empty());
        assert_model(&book);
    }

    #[test]
    fn d1_only_a_windows_own_webview_keeps_an_epoch() {
        assert!(records_epoch("main", "main"));
        assert!(records_epoch("session-1", "session-1"));
        assert!(!records_epoch("browser-guest-3", "main"));
    }

    #[test]
    fn d3_every_removal_cancels_the_slots_dial() {
        // Linger expiry.
        let mut book = pages();
        let (key, _) = acquire(&mut book, "conn:a::default", ssh("a"), lease("l1"));
        let dial = token(&book, &key);

        book.release("a", &lease("l1"), 0);
        assert!(!dial.is_cancelled(), "lingering keeps the dial");
        book.expire(LINGER_MS);
        assert!(dial.is_cancelled(), "expiry");

        // The primary lets go of a slot nobody else holds.
        let mut book = pages();
        let (key, _) = book
            .hold_primary("conn:a::default", ssh("a"), false, false, "p")
            .unwrap();
        let dial = token(&book, &key);

        assert_eq!(book.release_primary(&key), Some(Action::Teardown));
        assert!(dial.is_cancelled(), "release_primary");

        // The connection was edited or removed.
        let mut book = pages();
        let (key, _) = acquire(&mut book, "conn:a::default", ssh("a"), lease("l1"));
        let dial = token(&book, &key);

        book.drop_connection("a");
        assert!(dial.is_cancelled(), "drop_connection");

        // A retarget supersedes the dial for the old target.
        let mut book = pages();
        let (key, _) = acquire(&mut book, "conn:a::default", ssh("a"), lease("l1"));
        let dial = token(&book, &key);
        let mut moved = ssh("a");

        moved.fingerprint = ssh_fingerprint("deploy", "box2", 22, None, None);
        acquire(&mut book, &key, moved, lease("l2"));
        assert!(dial.is_cancelled(), "retarget");

        // Quit.
        let mut book = pages();
        let (key, _) = acquire(&mut book, "conn:a::default", ssh("a"), lease("l1"));
        let dial = token(&book, &key);

        book.quit();
        assert!(dial.is_cancelled(), "quit");
    }

    #[test]
    fn i26_a_superseded_dial_is_told_apart_from_a_removed_one() {
        // A restart.
        let mut book = pages();
        let (key, first) = book
            .hold_primary(LOCAL_SLOT, local(), false, false, "p")
            .unwrap();
        let restart = book.restart(&key, "restart");

        assert!(book.superseded(&key, serial_of(&first)));
        assert!(
            !book.superseded(&key, serial_of(&restart)),
            "the successor is current"
        );

        // An interactive request over a background dial.
        let (a, background) = acquire(&mut book, "conn:a::default", ssh("a"), lease("l1"));
        let (_, connect) = book
            .acquire(&a, ssh("a"), lease("l2"), true, "connect", 1)
            .unwrap();

        assert!(book.superseded(&a, serial_of(&background)));
        assert!(!book.superseded(&a, serial_of(&connect)));

        // A retarget is NOT a supersede: that caller asked for a different
        // backend, and joining would hand it a session to another host.
        let (b, old) = acquire(&mut book, "conn:b::default", ssh("b"), lease("l3"));
        let mut moved = ssh("b");

        moved.fingerprint = ssh_fingerprint("deploy", "box2", 22, None, None);
        let (_, retargeted) = acquire(&mut book, &b, moved, lease("l4"));

        assert!(
            !book.superseded(&b, serial_of(&old)),
            "a retargeted caller fails"
        );
        assert!(!book.superseded(&b, serial_of(&retargeted)));

        // Removed, not superseded: the caller fails.
        book.remove_slot(&a);

        assert!(!book.superseded(&a, serial_of(&background)));

        // A slot re-created at the key answers for its own dials only.
        acquire(&mut book, &a, ssh("a"), lease("l5"));

        assert!(!book.superseded(&a, serial_of(&background)));

        // A dial that failed on its own, then a newer dial: nothing recorded a
        // supersede, and failing the caller would remove the slot and cancel
        // that newer dial.
        let (c, failed) = book
            .hold_primary("conn:c::default", ssh("c"), false, false, "p")
            .unwrap();

        book.on_dial_result(&c, serial_of(&failed), Err(FailureKind::Transient));

        assert!(
            !book.superseded(&c, serial_of(&failed)),
            "nothing newer yet"
        );

        let (_, newer) = book.hold_primary(&c, ssh("c"), false, false, "p2").unwrap();

        assert!(book.superseded(&c, serial_of(&failed)));
        assert!(!book.superseded(&c, serial_of(&newer)));

        // However many restarts a slot lives through, it remembers one serial.
        let restarts: Vec<Action> = (0..5)
            .map(|n| book.restart(&c, &format!("restart-{n}")))
            .collect();

        assert_eq!(
            book.slot(&c).map(|slot| slot.superseded_max),
            Some(serial_of(&restarts[restarts.len() - 2]))
        );
        assert!(book.superseded(&c, serial_of(&failed)), "still superseded");

        // Quit drains every slot.
        book.quit();

        assert!(!book.superseded(&key, serial_of(&first)));
        assert!(!book.superseded(&b, serial_of(&old)));
        assert!(!book.superseded(&c, serial_of(&failed)));
    }

    #[test]
    fn i28_the_verdict_says_who_the_key_belongs_to_now() {
        let target = |spec: &SlotSpec| spec.fingerprint.clone();
        let a = ssh("a");
        let mut moved = ssh("a");

        moved.fingerprint = ssh_fingerprint("deploy", "box2", 22, None, None);

        // 1. No slot at all, and a dial nothing newer replaced: the caller fails.
        let mut book = pages();

        assert_eq!(book.join("conn:a::default", 1, &target(&a)), Verdict::Fail);

        let (key, own) = book
            .hold_primary("conn:a::default", a.clone(), false, false, "p")
            .unwrap();

        assert_eq!(
            book.join(&key, serial_of(&own), &target(&a)),
            Verdict::Fail,
            "its own dial is still the key's"
        );

        // 2. Superseded within the same origin era: join.
        let restart = book.restart(&key, "restart");

        assert_eq!(book.join(&key, serial_of(&own), &target(&a)), Verdict::Join);
        assert_eq!(
            book.join(&key, serial_of(&restart), &target(&a)),
            Verdict::Fail,
            "the current dial"
        );

        // 3b. Older than origin, same target, but a LEASE re-created the key:
        // the caller fails with its own kind, and takes no hold — a verdict is
        // not a hold, and there was never one to restore.
        book.remove_slot(&key);

        let (_, fresh) = acquire(&mut book, &key, a.clone(), lease("l1"));

        assert!(
            !book.slot(&key).unwrap().primary,
            "the re-created slot is a lease's"
        );
        assert_eq!(book.join(&key, serial_of(&own), &target(&a)), Verdict::Fail);
        assert!(
            !book.slot(&key).unwrap().primary,
            "the verdict took no hold"
        );
        assert_eq!(
            book.join(&key, serial_of(&fresh), &target(&a)),
            Verdict::Fail,
            "the re-created slot's own dial"
        );

        // …so the slot stays the lease's to end: once that lease goes, the
        // linger reaps it. Re-asserting the hold left `unheld()` false forever,
        // and the session, forward and remote backend lived until quit.
        book.release("a", &lease("l1"), 0);

        assert_eq!(
            book.expire(LINGER_MS),
            vec![(key.clone(), Action::Teardown)]
        );
        assert!(book.slot(&key).is_none(), "no tunnel outlives its holders");

        // 3a. The same key re-created by a newer PRIMARY attempt instead: that
        // attempt holds it and owns its release, so the displaced caller joins.
        let mut book = pages();
        let (key, own) = book
            .hold_primary("conn:a::default", a.clone(), false, false, "p")
            .unwrap();

        book.remove_slot(&key);

        let (_, fresh) = book
            .hold_primary(&key, a.clone(), false, false, "p2")
            .unwrap();

        assert!(
            book.slot(&key).unwrap().primary,
            "the re-creating attempt took the hold"
        );
        assert_eq!(book.join(&key, serial_of(&own), &target(&a)), Verdict::Join);
        assert_eq!(
            book.join(&key, serial_of(&fresh), &target(&a)),
            Verdict::Fail,
            "the re-created slot's own dial"
        );

        // 4. Older than origin, a different target the PRIMARY moved to: quiet,
        // because that attempt publishes its own result.
        let mut book = pages();
        let (key, own) = book
            .hold_primary("conn:a::default", a.clone(), false, false, "p")
            .unwrap();

        book.hold_primary(&key, moved.clone(), true, false, "p2")
            .unwrap();

        assert_eq!(
            book.join(&key, serial_of(&own), &target(&a)),
            Verdict::Quiet
        );
        // A caller that asked for the target the key now serves joins instead.
        assert_eq!(
            book.join(&key, serial_of(&own), &target(&moved)),
            Verdict::Join
        );

        // 5. Older than origin, a different target a LEASE moved to: the caller
        // fails with its own kind, so its UI resolves. Its hold stands until it
        // releases, and the lease's holder keeps the slot either way.
        let mut book = pages();
        let (key, own) = book
            .hold_primary("conn:a::default", a.clone(), false, false, "p")
            .unwrap();

        acquire(&mut book, &key, moved.clone(), lease("l2"));

        assert_eq!(book.join(&key, serial_of(&own), &target(&a)), Verdict::Fail);
        assert!(
            book.slot(&key).unwrap().primary,
            "the hold stands until its caller releases"
        );
        assert_eq!(book.release_primary(&key), Some(Action::None));
        assert!(book.slot(&key).is_some(), "the lease keeps the slot");

        // 5b. The same, when the newer owner CREATED the key rather than
        // retargeting it: a lease re-created it for another target, so the
        // displaced primary still fails loudly and resolves its own UI.
        let mut book = pages();
        let (key, own) = book
            .hold_primary("conn:a::default", a.clone(), false, false, "p")
            .unwrap();

        book.remove_slot(&key);
        acquire(&mut book, &key, moved.clone(), lease("l4"));

        assert_eq!(book.join(&key, serial_of(&own), &target(&a)), Verdict::Fail);

        // Local mirrors 3b: one constant fingerprint, so Quiet is unreachable
        // and only who re-created the key decides. A lease's local child is the
        // lease's, and `stopLocalBackend` during a cold start leaves no hold.
        let mut book = pages();
        let (local_key, first) = book
            .hold_primary(LOCAL_SLOT, local(), false, false, "p")
            .unwrap();

        book.remove_slot(&local_key);
        acquire(&mut book, &local_key, local(), lease("l3"));

        assert_eq!(
            book.join(&local_key, serial_of(&first), LOCAL_INSTANCE_KEY),
            Verdict::Fail
        );
        assert!(!book.slot(&local_key).unwrap().primary);

        book.release("local", &lease("l3"), 0);

        assert_eq!(
            book.expire(LINGER_MS),
            vec![(local_key.clone(), Action::Teardown)]
        );
        assert!(book.slot(&local_key).is_none(), "the child is reaped");

        // Quit leaves no key to belong to.
        let mut book = pages();
        let (local_key, first) = book
            .hold_primary(LOCAL_SLOT, local(), false, false, "p")
            .unwrap();

        book.quit();

        assert_eq!(
            book.join(&local_key, serial_of(&first), LOCAL_INSTANCE_KEY),
            Verdict::Fail
        );
    }

    #[test]
    fn i28_a_release_with_no_hold_to_release_does_nothing() {
        let mut book = pages();
        let (key, dial) = acquire(&mut book, "conn:a::default", ssh("a"), lease("l1"));
        let dial_token = token(&book, &key);

        assert!(!book.slot(&key).unwrap().primary, "the slot is a lease's");

        // The caller the verdict failed tears down as usual, and its release
        // finds no hold of its own: the lease's slot stands, and so does the
        // dial of the lease's era, which a removal here would have cancelled.
        assert_eq!(book.release_primary(&key), Some(Action::None));
        assert!(book.slot(&key).is_some(), "the lease keeps its slot");
        assert!(!dial_token.is_cancelled(), "and its dial keeps running");
        assert_eq!(token_serial(&book, &key), serial_of(&dial));

        // And once that lease lets go, the linger is still the lease's to spend:
        // a release arriving during it has nothing to give up either, so it
        // removes nothing, cancels nothing, and the grace runs its course.
        book.release("a", &lease("l1"), 0);

        assert_eq!(book.release_primary(&key), Some(Action::None));
        assert!(book.slot(&key).is_some(), "the grace is not cut short");
        assert!(!dial_token.is_cancelled(), "nor the lease's dial killed");
        assert!(book.expire(LINGER_MS - 1).is_empty());
        assert_eq!(
            book.expire(LINGER_MS),
            vec![(key.clone(), Action::Teardown)]
        );
    }

    #[test]
    fn i27_a_death_report_changes_nothing_but_a_ready_slot() {
        let mut book = pages();

        // Absent.
        assert_eq!(book.on_dead("conn:none::default"), Action::None);
        assert!(book.slot("conn:none::default").is_none());

        let observe = |book: &SlotBook, key: &str| {
            let slot = book.slot(key).expect("the slot stays");

            (
                slot.phase,
                slot.attempt,
                slot.failure,
                slot.dial.as_ref().map(|dial| dial.serial),
                slot.holders.len(),
            )
        };

        // Connecting.
        let (key, dial) = acquire(&mut book, "conn:a::default", ssh("a"), lease("l1"));
        let before = observe(&book, &key);

        assert_eq!(book.on_dead(&key), Action::None);
        assert_eq!(observe(&book, &key), before);

        // Retrying.
        ready(&mut book, &key, &dial);
        assert_eq!(book.on_dead(&key), Action::Redial { attempt: 1 });
        let before = observe(&book, &key);

        assert_eq!(book.on_dead(&key), Action::None);
        assert_eq!(observe(&book, &key), before);

        // Failed.
        let serial = book.begin_redial(&key, 1, "t").unwrap();

        book.on_dial_result(&key, serial, Err(FailureKind::Locked));
        let before = observe(&book, &key);

        assert_eq!(before.0, Phase::Failed);
        assert_eq!(book.on_dead(&key), Action::None);
        assert_eq!(observe(&book, &key), before);
    }

    #[test]
    fn i15_nothing_starts_after_quit() {
        let mut book = pages();
        let (key, dial) = acquire(&mut book, "conn:a::default", ssh("a"), lease("l1"));

        ready(&mut book, &key, &dial);
        book.quit();

        assert!(book.page_open("main", 0).is_none(), "page open");
        assert!(
            book.acquire("conn:a::default", ssh("a"), lease("l2"), false, "t", 1)
                .is_none(),
            "acquire"
        );
        assert!(book.slots.is_empty(), "a refused acquire inserts nothing");
        assert!(
            book.hold_primary("conn:a::default", ssh("a"), false, false, "p")
                .is_none(),
            "primary hold"
        );
        assert!(book.slots.is_empty());

        // A backoff timer that fires during the drain: the flag alone refuses it.
        let mut book = pages();
        let (key, dial) = acquire(&mut book, "conn:a::default", ssh("a"), lease("l1"));

        ready(&mut book, &key, &dial);
        assert_eq!(book.on_dead(&key), Action::Redial { attempt: 1 });
        book.quitting = true;
        assert!(book.begin_redial(&key, 1, "t").is_none(), "redial");
    }

    /// Every dial token the book has issued, and the serials whose result was
    /// credited. Invariant 25: an unsettled token is its slot's current dial,
    /// or it has been cancelled — no removal or supersede leaves a dial running
    /// that nothing waits on.
    #[derive(Default)]
    struct Ledger {
        issued: BTreeMap<u64, tokio_util::sync::CancellationToken>,
        settled: std::collections::BTreeSet<u64>,
        /// Every serial the book has told us a newer dial superseded.
        superseded: std::collections::BTreeSet<u64>,
    }

    struct Model {
        book: SlotBook,
        ledger: Ledger,
    }

    impl Model {
        /// Record the dials now in flight, then check the model's invariants.
        fn check(&mut self) {
            assert_model(&self.book);

            let current: BTreeMap<u64, ()> = self
                .book
                .slots
                .values()
                .filter_map(|slot| slot.dial.as_ref())
                .map(|dial| {
                    self.ledger
                        .issued
                        .entry(dial.serial)
                        .or_insert_with(|| dial.cancel.clone());

                    (dial.serial, ())
                })
                .collect();

            // 26: every dial the book superseded was cancelled when it was.
            for slot in self.book.slots.values() {
                if slot.superseded_max > 0 {
                    self.ledger.superseded.insert(slot.superseded_max);
                }
            }

            for serial in &self.ledger.superseded {
                let token = self
                    .ledger
                    .issued
                    .get(serial)
                    .unwrap_or_else(|| panic!("superseded dial {serial} was never seen"));

                assert!(token.is_cancelled(), "superseded dial {serial} still runs");
            }

            for (serial, token) in &self.ledger.issued {
                if self.ledger.settled.contains(serial) {
                    continue;
                }

                assert!(
                    current.contains_key(serial) || token.is_cancelled(),
                    "dial {serial} is running with no slot waiting on it"
                );
            }
        }

        fn acquire(&mut self, key: &str, spec: SlotSpec, holder: Holder) -> (String, Action) {
            let out = acquire(&mut self.book, key, spec, holder);

            self.check();

            out
        }

        /// A dial result; credited (settled) only when it is not stale.
        fn settle(&mut self, key: &str, serial: u64, result: Result<&str, FailureKind>) -> Action {
            let action = self.book.on_dial_result(key, serial, result);

            if action != Action::Stale {
                self.ledger.settled.insert(serial);
            }

            self.check();

            action
        }
    }

    #[test]
    fn the_lifecycle_model_holds_across_every_transition() {
        let mut m = Model {
            book: pages(),
            ledger: Ledger::default(),
        };

        // Lease dial, join, land.
        let (a, dial) = m.acquire("conn:a::default", ssh("a"), lease("l1"));
        m.acquire(&a, ssh("a"), Holder::new("session-x", "s1"));
        m.settle(&a, serial_of(&dial), Ok("http://127.0.0.1:1"));

        // Release one, reap a reloading page, destroy a window.
        m.book.release("a", &lease("l1"), 0);
        m.check();
        m.book.page_open("session-x", 1);
        m.check();
        let epoch = m.book.page_epoch("session-x").unwrap();
        m.book
            .acquire(
                &a,
                ssh("a"),
                Holder::new("session-x", "s2"),
                false,
                "t",
                epoch,
            )
            .unwrap();
        m.book.window_destroyed("session-x", 2);
        m.check();

        // Death, redial, transient failure, redial again.
        m.acquire(&a, ssh("a"), lease("l3"));
        assert_eq!(m.book.on_dead(&a), Action::Redial { attempt: 1 });
        m.check();
        let serial = m.book.begin_redial(&a, 1, "t").unwrap();
        m.check();
        m.settle(&a, serial, Err(FailureKind::Transient));
        let serial = m.book.begin_redial(&a, 2, "t").unwrap();
        m.check();
        m.settle(&a, serial, Ok("http://127.0.0.1:3"));

        // Primary adopt with a dead backend, restart mid-dial, retarget mid-dial.
        let (_, first) = m
            .book
            .hold_primary(&a, ssh("a"), false, false, "p")
            .unwrap();
        m.check();
        let restart = m.book.restart(&a, "restart");
        m.check();
        assert_eq!(
            m.settle(&a, serial_of(&first), Ok("http://127.0.0.1:4")),
            Action::Stale
        );
        let mut moved = ssh("a");
        moved.fingerprint = ssh_fingerprint("deploy", "box2", 22, None, None);
        let (_, retarget) = m.book.hold_primary(&a, moved, true, false, "p2").unwrap();
        m.check();
        assert_eq!(
            m.settle(&a, serial_of(&restart), Ok("http://127.0.0.1:5")),
            Action::Stale
        );
        m.settle(&a, serial_of(&retarget), Ok("http://127.0.0.1:6"));
        m.acquire(&a, ssh("a"), lease("l4"));
        m.book.release_primary(&a);
        m.check();

        // A primary dial the book retargets: neither joined nor released, and
        // the retarget's own dial keeps a live token.
        let (r, before) = m
            .book
            .hold_primary("conn:r::default", ssh("r"), false, false, "p")
            .unwrap();

        m.check();

        let mut moved = ssh("r");

        moved.fingerprint = ssh_fingerprint("deploy", "box9", 22, None, None);

        let (_, after) = m.book.hold_primary(&r, moved, true, false, "p2").unwrap();

        m.check();
        assert_eq!(
            m.book.join(&r, serial_of(&before), &ssh("r").fingerprint),
            Verdict::Quiet,
            "a primary retarget"
        );
        assert!(!m.book.superseded(&r, serial_of(&before)));
        assert!(
            !token(&m.book, &r).is_cancelled(),
            "the retarget's dial runs"
        );
        assert_eq!(serial_of(&after), token_serial(&m.book, &r));

        // A primary dial whose key is removed and then re-created by a LEASE:
        // the displaced serial fails, takes no hold, and the slot is still the
        // lease's to end — nothing is left holding a tunnel nobody owns.
        let (n, before) = m
            .book
            .hold_primary("conn:n::default", ssh("n"), false, false, "p")
            .unwrap();

        m.check();
        m.book.remove_slot(&n);
        m.acquire(&n, ssh("n"), lease("n1"));

        assert_eq!(
            m.book.join(&n, serial_of(&before), &ssh("n").fingerprint),
            Verdict::Fail,
            "a lease re-created the key"
        );
        assert!(
            !m.book.slot(&n).unwrap().primary,
            "the verdict took no hold"
        );

        m.book.release("n", &lease("n1"), 0);
        m.check();
        m.book.expire(LINGER_MS);
        m.check();

        assert!(m.book.slot(&n).is_none(), "the lease's slot is reapable");

        // A lease retargets a slot whose dial is in flight.
        let (d, _) = m.acquire("conn:d::default", ssh("d"), lease("d1"));
        let mut moved = ssh("d");
        moved.fingerprint = ssh_fingerprint("deploy", "box3", 22, None, None);
        m.acquire(&d, moved, lease("d2"));

        // An interactive request supersedes a background dial.
        let (e, _) = m.acquire("conn:e::default", ssh("e"), lease("e1"));
        m.book
            .acquire(&e, ssh("e"), lease("e2"), true, "connect", 1)
            .unwrap();
        m.check();

        // Removals, each with a dial in flight: linger expiry…
        let (b, _) = m.acquire("conn:b::default", ssh("b"), lease("b1"));
        m.book.release("b", &lease("b1"), 10);
        m.check();
        m.book.expire(10 + LINGER_MS);
        m.check();
        assert!(m.book.slot(&b).is_none());

        // …the primary letting go of a slot only it held…
        let (p, _) = m
            .book
            .hold_primary("conn:p::default", ssh("p"), false, false, "p")
            .unwrap();
        m.check();
        assert_eq!(m.book.release_primary(&p), Some(Action::Teardown));
        m.check();

        // …a dropped connection…
        let (c, _) = m.acquire("conn:c::default", ssh("c"), lease("c1"));
        m.book.drop_connection("c");
        m.check();
        assert!(m.book.slot(&c).is_none());

        // …a failed first dial (it holds no dial once settled)…
        let (f, dial) = m.acquire("conn:f::default", ssh("f"), lease("f1"));
        m.settle(&f, serial_of(&dial), Err(FailureKind::Transient));

        // …and quit, with two dials still in flight (d and e).
        m.acquire("conn:g::default", ssh("g"), lease("g1"));
        m.book.quit();
        m.check();
    }

    #[test]
    fn a_tunnel_error_carries_the_ssh_kind_it_came_from() {
        let timeout = TunnelError::from_ssh(&crate::ssh::error::SshError::new(
            SshErrorKind::Timeout,
            "timed out",
        ));

        assert_eq!(
            serde_json::to_value(&timeout).unwrap(),
            serde_json::json!({
                "kind": "transient",
                "message": "timed out",
                "terminal": false,
                "sshKind": "timeout"
            })
        );

        let locked = serde_json::to_value(TunnelError::new(FailureKind::Locked, "locked")).unwrap();

        assert!(locked.get("sshKind").is_none(), "{locked}");
    }

    #[cfg(desktop)]
    #[test]
    fn only_a_page_load_that_starts_reaps() {
        assert!(reaps_on_page_load(&tauri::webview::PageLoadEvent::Started));
        assert!(!reaps_on_page_load(
            &tauri::webview::PageLoadEvent::Finished
        ));
    }

    #[test]
    fn a_superseded_dial_is_cancelled_by_the_book_itself() {
        let mut book = pages();
        let (key, _) = acquire(&mut book, "conn:a::default", ssh("a"), lease("l1"));
        let background = book.slot(&key).unwrap().dial.clone().unwrap().cancel;

        // Whether the background dial's task has registered its attempt yet or
        // not, its token is already cancelled when the book supersedes it.
        book.acquire(&key, ssh("a"), lease("l2"), true, "connect-1", 1)
            .expect("a live page acquires");

        assert!(background.is_cancelled());

        let connect = book.slot(&key).unwrap().dial.clone().unwrap().cancel;

        assert!(!connect.is_cancelled(), "the new dial keeps a live token");

        // A restart supersedes the same way.
        book.restart(&key, "restart");

        assert!(connect.is_cancelled());
    }

    #[test]
    fn gap8_an_interactive_request_supersedes_a_background_dial_only() {
        let mut book = pages();
        let (key, background) = acquire(&mut book, "conn:a::default", ssh("a"), lease("l1"));

        let (_, connect) = book
            .acquire(&key, ssh("a"), lease("l2"), true, "connect-1", 1)
            .expect("a live page acquires");

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
        let (_, second) = book
            .acquire(&key, ssh("a"), lease("l3"), true, "connect-2", 1)
            .expect("a live page acquires");

        assert_eq!(second, Action::Join);
    }

    #[test]
    fn r4_a_destroyed_window_drops_only_its_own_holders() {
        let mut book = pages();
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
        let mut book = pages();
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

            // Asking again is what retries a terminal failure, and one that
            // needs a person is retried by a person's asking alone: the loop
            // comes back once that dial has landed.
            if kind.needs_person() {
                assert_eq!(
                    acquire(&mut book, &key, ssh("a"), lease("l1")).1,
                    Action::Refuse { kind }
                );

                let (_, connect) = book
                    .acquire(&key, ssh("a"), lease("l1"), true, "t", 1)
                    .expect("a live page acquires");

                ready(&mut book, &key, &connect);
                assert_eq!(book.on_dead(&key), Action::Redial { attempt: 1 });

                continue;
            }

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
        let mut book = pages();
        let (key, dial) = book
            .hold_primary("conn:a::default", ssh("a"), false, false, "p")
            .unwrap();

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

        let mut book = pages();
        let (key, dial) = book
            .hold_primary("conn:a::default", ssh("a"), false, false, "p")
            .unwrap();

        ready(&mut book, &key, &dial);

        // A re-tunnel changes the base and the generation, never the key.
        let (_, redial) = book
            .hold_primary(&key, ssh("a"), false, false, "p2")
            .unwrap();

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
        let mut book = pages();
        let (key, dial) = acquire(&mut book, LOCAL_SLOT, local(), lease("l1"));

        ready(&mut book, &key, &dial);

        assert_eq!(
            book.hold_primary(&key, local(), true, false, "p")
                .unwrap()
                .1,
            Action::Reuse
        );
        assert_eq!(book.quit().len(), 1);
        assert!(book.slot(&key).is_none());
    }

    #[test]
    fn r10_dropping_a_connection_ends_its_leased_slots() {
        let mut book = pages();
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
        let mut book = pages();
        let (key, dial) = acquire(&mut book, "conn:a::default", ssh("a"), lease("l1"));

        assert_eq!(
            book.on_dial_result(&key, serial_of(&dial), Err(FailureKind::Transient)),
            Action::Teardown
        );
        assert!(book.slot(&key).is_none());
    }

    const NEEDS_PERSON: [FailureKind; 3] = [
        FailureKind::Locked,
        FailureKind::CredentialsNeeded,
        FailureKind::HostKeyChanged,
    ];

    /// A background lease on `id` whose first dial ends on `kind`.
    fn fail_first_dial(book: &mut SlotBook, id: &str, kind: FailureKind) -> String {
        let (key, dial) = acquire(book, &format!("conn:{id}::default"), ssh(id), lease("l1"));

        assert_eq!(
            book.on_dial_result(&key, serial_of(&dial), Err(kind)),
            Action::Teardown
        );

        key
    }

    fn json(value: &impl Serialize) -> serde_json::Value {
        serde_json::to_value(value).unwrap()
    }

    #[test]
    fn np1_a_failure_that_needs_a_person_refuses_the_next_background_dial() {
        for kind in NEEDS_PERSON {
            let mut book = pages();
            let key = fail_first_dial(&mut book, "a", kind);
            let dials = book.serial;

            // The slot left with its failure; the budget did not.
            assert!(book.slot(&key).is_none());
            assert_eq!(book.needs_person("a").map(|entry| entry.kind), Some(kind));

            // A lease, then the primary: refused, and nothing is written.
            assert_eq!(
                acquire(&mut book, &key, ssh("a"), lease("l2")),
                (key.clone(), Action::Refuse { kind })
            );
            assert_eq!(
                book.hold_primary(&key, ssh("a"), false, false, "p"),
                Some((key.clone(), Action::Refuse { kind }))
            );
            assert_eq!(book.serial, dials, "{kind:?}: no dial began");
            assert!(book.slot(&key).is_none(), "{kind:?}: no slot, no holder");
            assert_model(&book);
        }

        // A slot that stays — it had landed once — is refused the same way, and
        // keeps what it had.
        let mut book = pages();
        let (key, dial) = acquire(&mut book, "conn:a::default", ssh("a"), lease("l1"));

        ready(&mut book, &key, &dial);
        assert_eq!(book.on_dead(&key), Action::Redial { attempt: 1 });

        let serial = book.begin_redial(&key, 1, "t").unwrap();

        assert_eq!(
            book.on_dial_result(&key, serial, Err(FailureKind::Locked)),
            Action::None
        );

        let dials = book.serial;
        let (_, action) = acquire(&mut book, &key, ssh("a"), lease("l2"));
        let slot = book.slot(&key).unwrap();

        assert_eq!(
            action,
            Action::Refuse {
                kind: FailureKind::Locked
            }
        );
        assert_eq!(book.serial, dials);
        assert_eq!((slot.phase, slot.dial.is_some()), (Phase::Failed, false));
        assert!(
            !slot.holders.contains(&lease("l2")),
            "a refusal holds nothing"
        );
        assert!(slot.holders.contains(&lease("l1")));
        assert_model(&book);
    }

    #[test]
    fn np2_a_person_asking_dials_and_the_result_decides_the_budget() {
        let mut book = pages();
        let key = fail_first_dial(&mut book, "a", FailureKind::CredentialsNeeded);

        let (_, connect) = book
            .acquire(&key, ssh("a"), lease("l2"), true, "connect", 1)
            .expect("a live page acquires");

        assert!(matches!(connect, Action::Dial { .. }), "{connect:?}");
        assert_eq!(
            book.needs_person("a").map(|entry| entry.kind),
            Some(FailureKind::CredentialsNeeded),
            "asking clears nothing"
        );

        // A background request arriving meanwhile joins the person's dial: it
        // would dial nothing, so there is nothing to refuse.
        assert_eq!(
            acquire(&mut book, &key, ssh("a"), lease("l3")).1,
            Action::Join
        );

        // That dial needing a person again records the new failure.
        book.on_dial_result(&key, serial_of(&connect), Err(FailureKind::HostKeyChanged));

        assert_eq!(
            acquire(&mut book, &key, ssh("a"), lease("l3")).1,
            Action::Refuse {
                kind: FailureKind::HostKeyChanged
            }
        );

        // The primary's interactive dial is never refused either, and the one
        // that lands ends the budget.
        let (_, primary) = book.hold_primary(&key, ssh("a"), false, true, "p").unwrap();

        assert!(matches!(primary, Action::Dial { .. }), "{primary:?}");
        assert!(book.needs_person("a").is_some());

        ready(&mut book, &key, &primary);
        assert!(book.needs_person("a").is_none());

        // A restart is a person changing something: it ends the budget outright.
        book.on_dead(&key);

        let (_, redial) = book
            .hold_primary(&key, ssh("a"), false, true, "p2")
            .unwrap();

        book.on_dial_result(&key, serial_of(&redial), Err(FailureKind::Locked));
        assert!(book.needs_person("a").is_some());
        assert!(matches!(book.restart(&key, "restart"), Action::Dial { .. }));
        assert!(book.needs_person("a").is_none());
        assert_model(&book);
    }

    #[test]
    fn np3_a_different_target_ends_the_budget() {
        let mut book = pages();
        let key = fail_first_dial(&mut book, "a", FailureKind::HostKeyChanged);
        let mut moved = ssh("a");

        moved.fingerprint = ssh_fingerprint("deploy", "box2", 22, None, None);

        let (_, dial) = acquire(&mut book, &key, moved.clone(), lease("l2"));

        assert!(matches!(dial, Action::Dial { .. }), "{dial:?}");
        assert!(book.needs_person("a").is_none());

        // The new target's failure is the new target's budget.
        book.on_dial_result(&key, serial_of(&dial), Err(FailureKind::Locked));

        assert_eq!(
            book.needs_person("a")
                .map(|entry| entry.fingerprint.clone()),
            Some(moved.fingerprint.clone())
        );
        assert!(matches!(
            acquire(&mut book, &key, ssh("a"), lease("l3")).1,
            Action::Dial { .. }
        ));
    }

    #[test]
    fn np4_a_dial_that_lands_ends_the_budget() {
        let mut book = pages();
        let key = fail_first_dial(&mut book, "a", FailureKind::Locked);
        let (_, connect) = book
            .acquire(&key, ssh("a"), lease("l2"), true, "connect", 1)
            .expect("a live page acquires");

        assert!(book.needs_person("a").is_some(), "it stands over the dial");

        ready(&mut book, &key, &connect);

        assert!(book.needs_person("a").is_none());

        // Signed in: once that tunnel is gone, the background dials again.
        book.release("a", &lease("l2"), 0);
        book.expire(LINGER_MS);

        assert!(matches!(
            acquire(&mut book, &key, ssh("a"), lease("l3")).1,
            Action::Dial { .. }
        ));
    }

    #[test]
    fn np5_a_dropped_or_saved_connection_ends_the_budget() {
        let mut book = pages();
        let key = fail_first_dial(&mut book, "a", FailureKind::CredentialsNeeded);

        fail_first_dial(&mut book, "b", FailureKind::CredentialsNeeded);

        // Edited or removed.
        assert!(book.drop_connection("a").is_empty());
        assert!(book.needs_person("a").is_none());
        assert!(book.needs_person("b").is_some(), "b's budget is b's");
        assert!(matches!(
            acquire(&mut book, &key, ssh("a"), lease("l2")).1,
            Action::Dial { .. }
        ));

        // Saved with nothing the dial reads changed: a new credential, say.
        book.person_acted("b");

        assert!(matches!(
            acquire(&mut book, "conn:b::default", ssh("b"), lease("l2")).1,
            Action::Dial { .. }
        ));
    }

    #[test]
    fn np6_only_a_failure_that_needs_a_person_is_budgeted() {
        for kind in [
            FailureKind::Transient,
            FailureKind::Cancelled,
            FailureKind::HermesNotFound,
            FailureKind::UpdateRequired,
            FailureKind::UnsupportedPlatform,
            FailureKind::Unavailable,
        ] {
            let mut book = pages();
            let key = fail_first_dial(&mut book, "a", kind);

            assert!(!kind.needs_person());
            assert!(book.needs_person("a").is_none(), "{kind:?}");
            assert!(
                matches!(
                    acquire(&mut book, &key, ssh("a"), lease("l1")).1,
                    Action::Dial { .. }
                ),
                "{kind:?} dials again"
            );
        }
    }

    #[test]
    fn np7_a_joiner_gets_the_dials_failure_and_the_budget_is_set_once() {
        let mut inner = Inner {
            book: pages(),
            ..Inner::default()
        };
        let (key, dial) = acquire(&mut inner.book, "conn:a::default", ssh("a"), lease("l1"));
        let (_, joined) = acquire(&mut inner.book, &key, ssh("a"), lease("l2"));

        assert_eq!(joined, Action::Join);

        let joiner = signal(&mut inner, &key).subscribe();
        let error = TunnelError::from_ssh(&crate::ssh::error::SshError::new(
            SshErrorKind::AuthFailed,
            "Permission denied",
        ));
        let before = inner.book.slot(&key).unwrap().clone();

        assert_eq!(
            inner
                .book
                .on_dial_result(&key, serial_of(&dial), Err(error.kind)),
            Action::Teardown
        );
        inner.book.publish_needs_person(
            "a",
            &error,
            failed_status(&before.spec, before.generation, &error),
        );
        settle_closed(&mut inner, &key, Some(&error));

        assert!(
            matches!(&*joiner.borrow(), Outcome::Failed(failed) if failed.terminal && failed.kind == FailureKind::CredentialsNeeded),
            "the joiner fails as the dial did"
        );

        // Nothing else records: not that dial's result again, and not a second
        // publish over the first.
        let late = TunnelError::new(FailureKind::Locked, "late");

        assert_eq!(
            inner
                .book
                .on_dial_result(&key, serial_of(&dial), Err(late.kind)),
            Action::Stale
        );
        inner.book.publish_needs_person(
            "a",
            &late,
            failed_status(&before.spec, before.generation, &late),
        );

        let entry = inner.book.needs_person("a").expect("set");

        assert_eq!(entry.kind, FailureKind::CredentialsNeeded);
        assert_eq!(
            entry.published.as_ref().map(|(error, _)| json(error)),
            Some(json(&error))
        );
    }

    #[test]
    fn np8_a_refusal_repeats_what_the_failed_dial_published() {
        let error = TunnelError::from_ssh(&crate::ssh::error::SshError::new(
            SshErrorKind::HostKeyChanged,
            "The host key changed. Run ssh-keygen -R box.",
        ));

        // A lease's first dial: its slot leaves, and `closed` publishes this.
        let mut inner = Inner {
            book: pages(),
            ..Inner::default()
        };
        let (key, dial) = acquire(&mut inner.book, "conn:a::default", ssh("a"), lease("l1"));
        let before = inner.book.slot(&key).unwrap().clone();
        let published = failed_status(&before.spec, before.generation, &error);

        inner
            .book
            .on_dial_result(&key, serial_of(&dial), Err(error.kind));
        inner
            .book
            .publish_needs_person("a", &error, published.clone());

        let (_, action) = acquire(&mut inner.book, &key, ssh("a"), lease("l1"));
        let Action::Refuse { kind } = action else {
            panic!("not refused: {action:?}");
        };
        let (refused_error, refused_status) = refused(&inner, "a", kind);

        assert_eq!(json(&refused_error), json(&error));
        assert_eq!(
            json(&refused_error),
            serde_json::json!({
                "kind": "host-key-changed",
                "message": "The host key changed. Run ssh-keygen -R box.",
                "terminal": true,
                "sshKind": "host-key-changed"
            })
        );
        assert_eq!(refused_status.as_ref().map(json), Some(json(&published)));

        // The primary's dial: its slot stays `Failed`, and `finish_dial`
        // publishes that slot's status — the same one.
        let mut book = pages();
        let (key, dial) = book
            .hold_primary("conn:a::default", ssh("a"), false, false, "p")
            .unwrap();

        book.on_dial_result(&key, serial_of(&dial), Err(error.kind));

        let slot = book.slot(&key).unwrap();

        assert_eq!(
            json(&status_of(
                slot,
                phase_of(slot),
                Some(error.message.clone())
            )),
            json(&failed_status(&slot.spec, slot.generation, &error))
        );
    }

    #[test]
    fn np9_a_dismissed_prompt_leaves_the_budget_standing() {
        let error = TunnelError::from_ssh(&crate::ssh::error::SshError::new(
            SshErrorKind::AuthFailed,
            "Permission denied",
        ));
        let mut inner = Inner {
            book: pages(),
            ..Inner::default()
        };
        let (key, dial) = acquire(&mut inner.book, "conn:a::default", ssh("a"), lease("l1"));
        let before = inner.book.slot(&key).unwrap().clone();
        let published = failed_status(&before.spec, before.generation, &error);

        inner
            .book
            .on_dial_result(&key, serial_of(&dial), Err(error.kind));
        inner
            .book
            .publish_needs_person("a", &error, published.clone());

        // Connect, and the person dismisses the question; then a blip.
        for dismissed in [FailureKind::Cancelled, FailureKind::Transient] {
            let (_, connect) = inner
                .book
                .acquire(&key, ssh("a"), lease("l2"), true, "connect", 1)
                .expect("a live page acquires");
            let late = TunnelError::new(dismissed, "not this one");

            assert_eq!(
                inner
                    .book
                    .on_dial_result(&key, serial_of(&connect), Err(dismissed)),
                Action::Teardown
            );
            inner.book.publish_needs_person(
                "a",
                &late,
                failed_status(&before.spec, before.generation, &late),
            );

            // The next background acquire: the ORIGINAL failure, and no dial.
            let dials = inner.book.serial;
            let (_, action) = acquire(&mut inner.book, &key, ssh("a"), lease("l3"));

            assert_eq!(
                action,
                Action::Refuse {
                    kind: FailureKind::CredentialsNeeded
                },
                "{dismissed:?}"
            );
            assert_eq!(inner.book.serial, dials, "{dismissed:?}: no dial began");
            assert!(inner.book.slot(&key).is_none());

            let (refused_error, refused_status) =
                refused(&inner, "a", FailureKind::CredentialsNeeded);

            assert_eq!(json(&refused_error), json(&error));
            assert_eq!(refused_status.as_ref().map(json), Some(json(&published)));
        }

        assert_model(&inner.book);
    }

    #[test]
    fn np10_the_redial_loop_stays_out_of_a_slot_that_needs_a_person() {
        // A leased slot that had landed, died, and then needed a person.
        let mut book = pages();
        let (key, dial) = acquire(&mut book, "conn:a::default", ssh("a"), lease("l1"));

        ready(&mut book, &key, &dial);
        book.on_dead(&key);

        let serial = book.begin_redial(&key, 1, "t").unwrap();

        book.on_dial_result(&key, serial, Err(FailureKind::Locked));

        // The person's dial fails on the network: no timer is armed, because
        // the redial it would run is a background dial like any other.
        let (_, connect) = book
            .acquire(&key, ssh("a"), lease("l1"), true, "connect", 1)
            .expect("a live page acquires");

        assert_eq!(
            book.on_dial_result(&key, serial_of(&connect), Err(FailureKind::Transient)),
            Action::None
        );
        assert_eq!(book.slot(&key).map(|slot| slot.phase), Some(Phase::Failed));

        // Nor when the primary hands such a slot back to its leases.
        let (_, primary) = book.hold_primary(&key, ssh("a"), false, true, "p").unwrap();

        book.on_dial_result(&key, serial_of(&primary), Err(FailureKind::Transient));

        assert_eq!(book.release_primary(&key), Some(Action::None));
        assert_eq!(book.slot(&key).map(|slot| slot.phase), Some(Phase::Failed));
        assert_eq!(
            acquire(&mut book, &key, ssh("a"), lease("l1")).1,
            Action::Refuse {
                kind: FailureKind::Locked
            }
        );
        assert_model(&book);
    }
}
