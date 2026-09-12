//! Bounded enumeration of what every source can serve.
//!
//! Three rules, each of which is a bug desktop shipped first:
//!
//!  1. **Every source races its own 10 s deadline, all concurrently.** One dead
//!     dial must not hold the roster behind a readiness timeout, and the total
//!     wall clock must not grow with the number of sources.
//!  2. **An SSH source is NEVER dialled from here.** A background poll that
//!     opens tunnels is how you get "stale key → respawn every 5 s →
//!     ECONNRESET"; a source that is only reachable by connecting to it says so
//!     and stays clickable.
//!  3. **An unreachable source contributes NOTHING.** It cannot shrink the
//!     roster (the last-known answer stands) and it cannot fake a duplicate
//!     handle (it contributes no rows to duplicate). Both halves matter — that
//!     pair is desktop's `6170021714`.
//!
//! The collapse itself is pure and lives in `registry.rs`; this module is the
//! I/O half that feeds it.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};
use tokio::sync::Mutex;

use super::registry::{
    build_agent_roster, seeds_when_unreachable, AgentRoster, Connection, ConnectionKind, Registry,
    SourceProfiles,
};

/// Per source. A source slower than this is reported unreachable and retried on
/// the next poll rather than holding everything else up.
const PER_SOURCE_TIMEOUT: Duration = Duration::from_secs(10);
/// A backend's `install_id` changes only when the backend is reinstalled, so a
/// generous positive TTL is free. The negative one is short because "we could
/// not reach it" is exactly the answer most likely to be stale.
const INSTALL_ID_TTL: Duration = Duration::from_secs(5 * 60);
const INSTALL_ID_NEGATIVE_TTL: Duration = Duration::from_secs(60);

#[derive(Default)]
pub struct RosterCache {
    /// base URL → (install id, when it was learned).
    install_ids: Mutex<HashMap<String, (Option<String>, Instant)>>,
    /// connection id → the last profile list it actually answered with. This is
    /// what keeps an unreachable source from shrinking the roster.
    last_seen: Mutex<HashMap<String, Vec<String>>>,
}

impl RosterCache {
    async fn install_id(&self, app: &AppHandle, base_url: &str, force: bool) -> Option<String> {
        if !force {
            if let Some((cached, at)) = self.install_ids.lock().await.get(base_url) {
                let ttl = if cached.is_some() {
                    INSTALL_ID_TTL
                } else {
                    INSTALL_ID_NEGATIVE_TTL
                };

                if at.elapsed() < ttl {
                    return cached.clone();
                }
            }
        }

        let url = format!("{}/api/status", base_url.trim_end_matches('/'));
        let learned = crate::transport::probe_get_json(app, &url, Duration::from_secs(8))
            .await
            .ok()
            .and_then(|(status, body)| {
                (200..300).contains(&status).then(|| {
                    body.get("install_id")
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_string)
                })
            })
            .flatten();

        self.install_ids
            .lock()
            .await
            .insert(base_url.to_string(), (learned.clone(), Instant::now()));

        learned
    }

    async fn remember(&self, connection_id: &str, profiles: &[String]) {
        self.last_seen
            .lock()
            .await
            .insert(connection_id.to_string(), profiles.to_vec());
    }

    async fn recall(&self, connection_id: &str) -> Option<Vec<String>> {
        self.last_seen.lock().await.get(connection_id).cloned()
    }
}

/// `GET /api/profiles` → the names it lists, with `default` always present. The
/// root HERMES_HOME is an agent too, even on a backend that does not list it.
async fn list_profiles(app: &AppHandle, base_url: &str) -> Result<Vec<String>, String> {
    let url = format!("{}/api/profiles", base_url.trim_end_matches('/'));
    let (status, body) =
        crate::transport::probe_get_json(app, &url, Duration::from_secs(8)).await?;

    if !(200..300).contains(&status) {
        return Err(format!("HTTP {status}"));
    }

    let mut names = vec!["default".to_string()];

    if let Some(list) = body.get("profiles").and_then(serde_json::Value::as_array) {
        for entry in list {
            let name = entry
                .get("name")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
                .trim();

            if !name.is_empty() && !names.iter().any(|held| held == name) {
                names.push(name.to_string());
            }
        }
    }

    Ok(names)
}

/// One source's report. Never dials anything that is not already reachable.
async fn enumerate(
    app: AppHandle,
    connection: Connection,
    cache: Arc<RosterCache>,
    force: bool,
) -> SourceProfiles {
    let mut report = SourceProfiles {
        connection_id: connection.id.clone(),
        error: None,
        install_id: None,
        kind: connection.kind,
        label: connection.label.clone(),
        observed: false,
        order: connection.order,
        profiles: None,
    };

    let base_url = match connection.kind {
        ConnectionKind::Cloud | ConnectionKind::Remote => connection.url.clone(),
        ConnectionKind::Local => local_base_url(&app).await,
        ConnectionKind::Ssh => None,
    };

    let Some(base_url) = base_url else {
        if !seeds_when_unreachable(connection.kind) {
            // A local source with no live child contributes NOTHING until one
            // is up — the rule and its reasoning live on the predicate.
            report.error = Some("not-running".to_string());

            return report;
        }

        // Seeded with the one profile its backend runs as, so the device stays
        // clickable without anything being dialled — desktop does the same
        // (`rememberSshEnumeration`). It stays `observed: false`, because
        // "connect to find out" and "a backend answered" are different facts
        // and only the flag can tell them apart.
        report.error = Some("connect-on-demand".to_string());
        report.profiles = Some(vec![connection
            .remote_profile
            .clone()
            .unwrap_or_else(|| "default".to_string())]);

        return report;
    };

    match list_profiles(&app, &base_url).await {
        Ok(profiles) => {
            cache.remember(&connection.id, &profiles).await;
            report.install_id = cache.install_id(&app, &base_url, force).await;
            report.observed = true;
            report.profiles = Some(profiles);
        }
        Err(error) => {
            report.error = Some(error);
            // The last answer it DID give stands. A never-seen remote stays
            // empty on purpose: an unreachable URL is not evidence a backend
            // exists there.
            report.profiles = cache.recall(&connection.id).await;
            // A recalled list WAS enumerated, just not on this pass — the
            // backend demonstrably existed. That is what keeps a briefly
            // unreachable machine's bots on screen instead of blinking out.
            report.observed = report.profiles.is_some();
        }
    }

    report
}

async fn local_base_url(app: &AppHandle) -> Option<String> {
    crate::local_backend::running_base_url(&app.state::<crate::local_backend::LocalBackendState>())
        .await
}

/// Enumerate every source concurrently and collapse the result (§8.10).
pub async fn collect_roster(
    app: &AppHandle,
    registry: &Registry,
    cache: Arc<RosterCache>,
    active_connection_id: Option<&str>,
    force: bool,
) -> AgentRoster {
    let mut tasks = Vec::new();

    for connection in registry.connections.clone() {
        let app = app.clone();
        let cache = Arc::clone(&cache);
        let id = connection.id.clone();
        let kind = connection.kind;
        let label = connection.label.clone();
        let order = connection.order;

        tasks.push(tokio::spawn(async move {
            match tokio::time::timeout(PER_SOURCE_TIMEOUT, enumerate(app, connection, cache, force))
                .await
            {
                Ok(report) => report,
                // Rule 1: the deadline produces a ROW, not a missing source.
                Err(_) => SourceProfiles {
                    connection_id: id,
                    error: Some("timeout".to_string()),
                    install_id: None,
                    kind,
                    label,
                    observed: false,
                    order,
                    profiles: None,
                },
            }
        }));
    }

    let mut reports = Vec::with_capacity(tasks.len());

    for task in tasks {
        if let Ok(report) = task.await {
            reports.push(report);
        }
    }

    build_agent_roster(&reports, active_connection_id)
}
