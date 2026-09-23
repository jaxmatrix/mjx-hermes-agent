//! Loopback reach: making an agent's `http://localhost:5173` — which names the
//! GATEWAY's machine — actually load in the pane on this one.
//!
//! The ticket's premise that universal has "no forward primitive" is inverted:
//! `ssh::forward::open(session, remote_port)` already opens a russh
//! direct-tcpip channel behind a kernel-picked `127.0.0.1:0` listener. What is
//! missing is the layer ABOVE it — a lease per (connection scope, remote port),
//! with a TTL that is actually refreshed on reuse (the Electron desktop app's
//! registry documents a 15-minute refresh and never does it) and a teardown on
//! every path that changes which machine "localhost" means.
//!
//! The lease is keyed on the 446 connection scope, never on a base URL
//! (rule 19): two SSH sources on one profile name are two machines.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::sync::Mutex;

use super::reach_url::{loopback_target, rewrite_to_local_port};

/// Refreshed on every reuse. A dev server the user is actively browsing must
/// not have its tunnel pulled out from under it at the 15-minute mark.
pub const LEASE_TTL: Duration = Duration::from_secs(15 * 60);

/// What a lease holds open. A trait rather than `PortForward` directly so the
/// registry's TTL/reuse/teardown rules unit-test without an SSH server.
pub trait LeaseHandle: Send + Sync {
    fn local_port(&self) -> u16;
    /// Stop accepting. In-flight connections finish on their own.
    fn close(&self);
}

impl LeaseHandle for crate::ssh::forward::PortForward {
    fn local_port(&self) -> u16 {
        self.local_port
    }

    fn close(&self) {
        crate::ssh::forward::PortForward::close(self);
    }
}

struct ForwardLease {
    handle: Box<dyn LeaseHandle>,
    expires_at: Instant,
}

/// Why a URL came back unchanged. The Electron desktop app returns `null` here
/// and cannot tell "it was never loopback" from "the forward failed" — which is
/// exactly the difference the pane needs to decide whether to explain anything
/// (rule 9).
// `GatewayNotSsh` is synthesised on the TS side, which is the half that knows
// the gateway's mode; it lives here so both halves name it the same way.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ReachNote {
    NotLoopback,
    GatewayNotSsh,
    NoSession,
    ForwardFailed,
    ConnectionGone,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReachResult {
    /// Rewritten, or the ORIGINAL unchanged. NEVER null: a caller must not read
    /// an unchanged URL as failure.
    pub url: String,
    pub leased: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<ReachNote>,
}

impl ReachResult {
    fn unchanged(url: &str, note: ReachNote) -> Self {
        Self {
            url: url.to_string(),
            leased: false,
            local_port: None,
            note: Some(note),
        }
    }
}

#[derive(Default)]
pub struct ForwardLeases {
    map: Mutex<HashMap<(String, u16), ForwardLease>>,
}

impl ForwardLeases {
    /// A live lease for this (scope, remote port), with its TTL REFRESHED.
    ///
    /// Sweeping every expired lease on the way through is deliberate: it means
    /// there is no background timer task to start, stop or leak.
    ///
    /// ponytail: sweep-on-access. A lease nobody touches again holds one
    /// loopback socket until the SSH session dies or the gateway switches —
    /// both of which drop it. Upgrade path is a 60 s `tokio::time::interval`
    /// if an idle socket ever matters.
    pub async fn reuse(&self, scope: &str, remote_port: u16, now: Instant) -> Option<u16> {
        let mut map = self.map.lock().await;

        map.retain(|_, lease| {
            if lease.expires_at > now {
                return true;
            }

            lease.handle.close();
            false
        });

        let lease = map.get_mut(&(scope.to_string(), remote_port))?;
        lease.expires_at = now + LEASE_TTL;

        Some(lease.handle.local_port())
    }

    pub async fn insert(
        &self,
        scope: &str,
        remote_port: u16,
        now: Instant,
        handle: Box<dyn LeaseHandle>,
    ) -> u16 {
        let local_port = handle.local_port();

        let previous = self.map.lock().await.insert(
            (scope.to_string(), remote_port),
            ForwardLease {
                handle,
                expires_at: now + LEASE_TTL,
            },
        );

        if let Some(previous) = previous {
            previous.handle.close();
        }

        local_port
    }

    /// Every lease for one connection scope. Called on `ssh_disconnect`, on the
    /// unexpected-death path, and whenever the identity behind a scope changes:
    /// a new host must never inherit a tunnel into the old one.
    pub async fn drop_scope(&self, scope: &str) -> u32 {
        let mut map = self.map.lock().await;
        let mut closed = 0;

        map.retain(|(key_scope, _), lease| {
            if key_scope != scope {
                return true;
            }

            lease.handle.close();
            closed += 1;
            false
        });

        closed
    }

    /// Every lease, everywhere. The gateway switch door.
    pub async fn drop_all(&self) -> u32 {
        let mut map = self.map.lock().await;
        let closed = map.len() as u32;

        for (_, lease) in map.drain() {
            lease.handle.close();
        }

        closed
    }
}

/// Resolve a URL against the tunnel, opening one if it is worth opening.
///
/// EVERY failure path returns the original URL. Not being reachable is not an
/// error: a `url`/`cloud`/`local` gateway simply has no tunnel to borrow, and
/// the pane explains that on its own from the `note`.
pub async fn reach(
    leases: &ForwardLeases,
    ssh: &crate::ssh::SshState,
    url: &str,
    scope_key: &str,
) -> ReachResult {
    let Some(target) = loopback_target(url) else {
        return ReachResult::unchanged(url, ReachNote::NotLoopback);
    };

    let now = Instant::now();

    if let Some(local_port) = leases.reuse(scope_key, target.port, now).await {
        return rewritten(url, local_port);
    }

    let Some(session) = ssh.session_for_scope(scope_key).await else {
        return ReachResult::unchanged(url, ReachNote::NoSession);
    };

    let forward = match crate::ssh::forward::open(Arc::clone(&session), target.port).await {
        Ok(forward) => forward,
        Err(err) => {
            log::warn!(
                "browser: could not forward remote port {}: {err}",
                target.port
            );
            return ReachResult::unchanged(url, ReachNote::ForwardFailed);
        }
    };

    // The session can die between the lookup and the open. A forward over a
    // dead session is a listener that answers and then hangs.
    if !session.is_alive() {
        forward.close();
        return ReachResult::unchanged(url, ReachNote::ConnectionGone);
    }

    let local_port = leases
        .insert(scope_key, target.port, now, Box::new(forward))
        .await;

    rewritten(url, local_port)
}

fn rewritten(url: &str, local_port: u16) -> ReachResult {
    match rewrite_to_local_port(url, local_port) {
        Some(rewritten) => ReachResult {
            url: rewritten,
            leased: true,
            local_port: Some(local_port),
            note: None,
        },
        // Unreachable in practice — `loopback_target` already parsed it — but a
        // rewrite that cannot be built must not become a silently wrong URL.
        None => ReachResult::unchanged(url, ReachNote::NotLoopback),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    struct FakeForward {
        port: u16,
        closes: Arc<AtomicUsize>,
    }

    impl LeaseHandle for FakeForward {
        fn local_port(&self) -> u16 {
            self.port
        }

        fn close(&self) {
            self.closes.fetch_add(1, Ordering::SeqCst);
        }
    }

    fn fake(port: u16, closes: &Arc<AtomicUsize>) -> Box<dyn LeaseHandle> {
        Box::new(FakeForward {
            port,
            closes: Arc::clone(closes),
        })
    }

    #[tokio::test]
    async fn one_lease_serves_every_page_on_one_remote_port() {
        let leases = ForwardLeases::default();
        let closes = Arc::new(AtomicUsize::new(0));
        let now = Instant::now();

        leases.insert("work", 5173, now, fake(41000, &closes)).await;

        // `/`, `/about`, `?q=1` are all the same tunnel. A lease per page would
        // leak a socket per click.
        assert_eq!(leases.reuse("work", 5173, now).await, Some(41000));
        assert_eq!(leases.reuse("work", 5173, now).await, Some(41000));
        assert_eq!(closes.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn a_distinct_remote_port_gets_its_own_lease() {
        let leases = ForwardLeases::default();
        let closes = Arc::new(AtomicUsize::new(0));
        let now = Instant::now();

        leases.insert("work", 5173, now, fake(41000, &closes)).await;
        leases.insert("work", 8000, now, fake(41001, &closes)).await;

        assert_eq!(leases.reuse("work", 5173, now).await, Some(41000));
        assert_eq!(leases.reuse("work", 8000, now).await, Some(41001));
    }

    #[tokio::test]
    async fn reuse_refreshes_the_ttl() {
        // Deleting the `expires_at = now + LEASE_TTL` line in `reuse` turns
        // this red. That omission is the Electron desktop app's live bug: its
        // registry documents the refresh and never performs it, so a dev server
        // someone has been reading for 15 minutes loses its tunnel mid-scroll.
        let leases = ForwardLeases::default();
        let closes = Arc::new(AtomicUsize::new(0));
        let start = Instant::now();

        leases
            .insert("work", 5173, start, fake(41000, &closes))
            .await;

        let later = start + LEASE_TTL - Duration::from_secs(1);
        assert_eq!(leases.reuse("work", 5173, later).await, Some(41000));

        // Without the refresh this lookup is past `start + TTL` and dead.
        let much_later = later + LEASE_TTL - Duration::from_secs(1);
        assert_eq!(leases.reuse("work", 5173, much_later).await, Some(41000));
        assert_eq!(closes.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn an_expired_lease_is_closed_and_not_served() {
        let leases = ForwardLeases::default();
        let closes = Arc::new(AtomicUsize::new(0));
        let start = Instant::now();

        leases
            .insert("work", 5173, start, fake(41000, &closes))
            .await;

        let expired = start + LEASE_TTL + Duration::from_secs(1);
        assert_eq!(leases.reuse("work", 5173, expired).await, None);
        assert_eq!(
            closes.load(Ordering::SeqCst),
            1,
            "the socket must be released"
        );
    }

    #[tokio::test]
    async fn drop_scope_tears_down_that_scope_only() {
        let leases = ForwardLeases::default();
        let closes = Arc::new(AtomicUsize::new(0));
        let now = Instant::now();

        leases.insert("work", 5173, now, fake(41000, &closes)).await;
        leases.insert("work", 8000, now, fake(41001, &closes)).await;
        leases
            .insert("conn:b::home", 5173, now, fake(41002, &closes))
            .await;

        assert_eq!(leases.drop_scope("work").await, 2);
        assert_eq!(closes.load(Ordering::SeqCst), 2);
        assert_eq!(leases.reuse("work", 5173, now).await, None);
        assert_eq!(leases.reuse("conn:b::home", 5173, now).await, Some(41002));
    }

    #[tokio::test]
    async fn drop_all_is_the_gateway_switch_door() {
        let leases = ForwardLeases::default();
        let closes = Arc::new(AtomicUsize::new(0));
        let now = Instant::now();

        leases.insert("work", 5173, now, fake(41000, &closes)).await;
        leases
            .insert("conn:b::home", 5173, now, fake(41002, &closes))
            .await;

        assert_eq!(leases.drop_all().await, 2);
        assert_eq!(closes.load(Ordering::SeqCst), 2);
        assert_eq!(leases.drop_all().await, 0, "idempotent");
    }

    #[tokio::test]
    async fn replacing_a_lease_closes_the_one_it_replaced() {
        let leases = ForwardLeases::default();
        let closes = Arc::new(AtomicUsize::new(0));
        let now = Instant::now();

        leases.insert("work", 5173, now, fake(41000, &closes)).await;
        leases.insert("work", 5173, now, fake(41009, &closes)).await;

        assert_eq!(closes.load(Ordering::SeqCst), 1);
        assert_eq!(leases.reuse("work", 5173, now).await, Some(41009));
    }

    #[test]
    fn a_non_loopback_url_is_returned_unchanged_and_says_why() {
        let result = ReachResult::unchanged("https://example.com/", ReachNote::NotLoopback);

        assert_eq!(result.url, "https://example.com/");
        assert!(!result.leased);
        assert_eq!(result.note, Some(ReachNote::NotLoopback));
    }

    #[test]
    fn a_rewrite_reports_the_port_it_leased() {
        let result = rewritten("http://localhost:5173/x?q=1", 41000);

        assert_eq!(result.url, "http://127.0.0.1:41000/x?q=1");
        assert!(result.leased);
        assert_eq!(result.local_port, Some(41000));
        assert_eq!(result.note, None);
    }
}
