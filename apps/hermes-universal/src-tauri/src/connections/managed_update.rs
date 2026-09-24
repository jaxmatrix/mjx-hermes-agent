//! Transactional managed SSH update (`hermesDesktop.connections.updateManaged`).
//!
//! Electron SoT: `managed-ssh-update.ts` + `updateManagedSshConnection` in main.
//! Universal's SSH serves are already owned by [`crate::tunnels`], so the
//! drain/restore dance collapses to: single-flight gate → require a live tunnel
//! base URL → POST `/api/hermes/update` → report the correlated result shape
//! desktop's Managed updates UI expects.

use std::collections::HashSet;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, State};

use super::error::ConnectionsError;
use super::registry::ConnectionKind;
use super::{publish_auth, ConnectionsState};

#[derive(Default)]
pub struct ManagedUpdateGate {
    inflight: Mutex<HashSet<String>>,
}

impl ManagedUpdateGate {
    fn try_claim(&self, connection_id: &str) -> bool {
        let Ok(mut set) = self.inflight.lock() else {
            return false;
        };
        set.insert(connection_id.to_string())
    }

    fn release(&self, connection_id: &str) {
        if let Ok(mut set) = self.inflight.lock() {
            set.remove(connection_id);
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedUpdateReceipt {
    pub correlation_id: String,
    pub outcome: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pre_sha: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub post_sha: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pre_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub post_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_reason: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedUpdateScopeResult {
    pub profile: String,
    pub restored: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedConnectionUpdateResult {
    pub connection_id: String,
    pub correlation_id: String,
    pub ok: bool,
    pub update_ok: bool,
    pub restore_ok: bool,
    pub outcome: String,
    pub exit_code: Option<i32>,
    pub receipt: Option<ManagedUpdateReceipt>,
    pub scopes: Vec<ManagedUpdateScopeResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

fn correlation_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    // UUID-shaped enough for the renderer + logs; not cryptographic.
    format!(
        "{:08x}-{:04x}-4{:03x}-8{:03x}-{:012x}",
        (nanos >> 96) as u32,
        (nanos >> 80) as u16,
        ((nanos >> 64) as u16) & 0x0fff,
        ((nanos >> 48) as u16) & 0x0fff,
        nanos as u64 & 0x0000_ffffffffffff
    )
}

fn refused(
    connection_id: &str,
    correlation_id: &str,
    message: &str,
) -> ManagedConnectionUpdateResult {
    ManagedConnectionUpdateResult {
        connection_id: connection_id.to_string(),
        correlation_id: correlation_id.to_string(),
        ok: false,
        update_ok: false,
        restore_ok: true,
        outcome: "refused".into(),
        exit_code: None,
        receipt: None,
        scopes: vec![],
        error: Some(message.into()),
        message: Some(message.into()),
    }
}

/// Update one managed SSH connection through its live tunnelled gateway.
#[tauri::command]
pub async fn connections_update_managed(
    app: AppHandle,
    state: State<'_, ConnectionsState>,
    gate: State<'_, ManagedUpdateGate>,
    id: String,
) -> Result<ManagedConnectionUpdateResult, ConnectionsError> {
    let connection_id = id.trim().to_string();
    let correlation = correlation_id();

    if connection_id.is_empty() {
        return Ok(refused("", &correlation, "Missing connection id."));
    }

    if !gate.try_claim(&connection_id) {
        return Ok(refused(
            &connection_id,
            &correlation,
            "A managed update is already in progress for this connection.",
        ));
    }

    let result = run_managed_update(&app, &state, &connection_id, &correlation).await;
    gate.release(&connection_id);
    Ok(result)
}

async fn run_managed_update(
    app: &AppHandle,
    state: &ConnectionsState,
    connection_id: &str,
    correlation: &str,
) -> ManagedConnectionUpdateResult {
    let registry = state.load(app);
    let Some(connection) = registry
        .connections
        .iter()
        .find(|row| row.id == connection_id)
        .cloned()
    else {
        return refused(connection_id, correlation, "Connection not found.");
    };

    if connection.kind != ConnectionKind::Ssh {
        return refused(
            connection_id,
            correlation,
            "Managed updates apply only to SSH connections.",
        );
    }

    publish_auth(app, &registry, &connection);

    let base_url = crate::tunnels::base_url_for(app, connection_id);

    let Some(base_url) = base_url else {
        return refused(
            connection_id,
            correlation,
            "Connect to this SSH gateway before running a managed update.",
        );
    };

    let url = format!("{}/api/hermes/update", base_url.trim_end_matches('/'));
    let started_at = chrono_like_now();

    match crate::transport::probe_post_json(app, &url, std::time::Duration::from_secs(120)).await {
        Ok((status, body)) => {
            let update_ok = (200..300).contains(&status)
                && body
                    .get("ok")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(true);
            let message = body
                .get("message")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
                .or_else(|| {
                    body.get("error")
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_string)
                });
            let outcome = if update_ok {
                "updated"
            } else {
                "update-failed"
            };

            ManagedConnectionUpdateResult {
                connection_id: connection_id.to_string(),
                correlation_id: correlation.to_string(),
                ok: update_ok,
                update_ok,
                restore_ok: true,
                outcome: outcome.into(),
                exit_code: if update_ok { Some(0) } else { Some(1) },
                receipt: Some(ManagedUpdateReceipt {
                    correlation_id: correlation.to_string(),
                    outcome: outcome.into(),
                    started_at: Some(started_at),
                    finished_at: Some(chrono_like_now()),
                    pre_sha: None,
                    post_sha: None,
                    pre_version: None,
                    post_version: None,
                    stop_reason: None,
                }),
                scopes: vec![ManagedUpdateScopeResult {
                    profile: "default".into(),
                    restored: true,
                    error: None,
                }],
                error: if update_ok { None } else { message.clone() },
                message,
            }
        }
        Err(error) => ManagedConnectionUpdateResult {
            connection_id: connection_id.to_string(),
            correlation_id: correlation.to_string(),
            ok: false,
            update_ok: false,
            restore_ok: true,
            outcome: "update-failed".into(),
            exit_code: None,
            receipt: None,
            scopes: vec![ManagedUpdateScopeResult {
                profile: "default".into(),
                restored: true,
                error: None,
            }],
            error: Some(error.clone()),
            message: Some(error),
        },
    }
}

fn chrono_like_now() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{secs}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn correlation_looks_like_uuid() {
        let id = correlation_id();
        assert_eq!(id.len(), 36);
        assert_eq!(id.chars().filter(|c| *c == '-').count(), 4);
    }

    #[test]
    fn gate_is_single_flight() {
        let gate = ManagedUpdateGate::default();
        assert!(gate.try_claim("a"));
        assert!(!gate.try_claim("a"));
        gate.release("a");
        assert!(gate.try_claim("a"));
    }

    #[test]
    fn refused_serialises_camel_case() {
        let json = serde_json::to_value(refused("box", "corr", "nope")).unwrap();
        assert_eq!(json["connectionId"], "box");
        assert_eq!(json["outcome"], "refused");
        assert_eq!(json["updateOk"], false);
    }
}
