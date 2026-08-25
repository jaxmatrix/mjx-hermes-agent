//! The two-leg health probe.
//!
//! Two legs because an HTTP-passing gateway still rejects the WS upgrade: it is
//! a different transport with different credentials, and the server applies
//! Host/Origin checks, ws-ticket/token auth and peer-IP guards to an upgrade
//! that `/api/status` never sees. A probe that only asked leg 1 would report a
//! gateway healthy while its chat socket is refused every time.
//!
//! `classify_probe` is the PURE half (rule 35): the legs do the I/O and hand it
//! observations, and it maps those to a verdict with no clock, socket or app
//! handle involved. The constants are desktop's (`gateway-ws-probe.ts`) and are
//! pinned by a test on both ends the way `data_url_read_max` is.

use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::AppHandle;

use super::error::ConnectionsError;
use super::registry::{AuthMode, Connection, ConnectionKind};

/// How long an upgrade may take to produce anything at all.
pub const CONNECT_TIMEOUT_MS: u64 = 10_000;
/// A socket that is still open this long after the upgrade has passed its
/// credential check. A gateway that refuses the credential accepts the TCP
/// connection first and closes immediately after — inside this window.
pub const READY_GRACE_MS: u64 = 750;
/// The HTTP leg's own budget. Deliberately the same 8 s `probeStatus` uses so a
/// slow-but-alive gateway does not probe as dead while authenticating fine.
pub const STATUS_TIMEOUT_MS: u64 = 8_000;

#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ProbeVerdict {
    Ok,
    /// The gateway accepted the connection and then closed it.
    CredentialRejected,
    Unreachable,
    /// Leg 1 answered 401/403 — sign-in is what is missing, not the gateway.
    AuthRequired,
    /// Token mode with no stored token: a genuine skip, and still `ok`.
    SkippedNoToken,
    WsUnreachable,
    Timeout,
}

#[derive(Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct LegResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    pub ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// What leg 2 actually saw. A struct rather than a verdict so the classification
/// stays in one testable place.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WsObservation {
    pub opened: bool,
    /// A frame arrived — the strongest possible evidence, and it wins immediately.
    pub frame: bool,
    pub closed_after_open: bool,
    pub closed_before_open: bool,
    pub timed_out: bool,
    /// Token mode with nothing stored: nothing was attempted.
    pub skipped_no_token: bool,
    /// The ws-ticket mint failed. NOT a skip — see `classify_probe`.
    pub mint_failed: bool,
    /// …and the mint failed with a 401/403, so what is missing is a sign-in.
    pub mint_unauthorized: bool,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    pub ok: bool,
    pub http: LegResult,
    pub ws: LegResult,
    pub verdict: ProbeVerdict,
    pub needs_oauth_login: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub install_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    pub auth_flows: Vec<String>,
    /// Whether the gateway says it is gated at all.
    pub auth_required: bool,
}

/// The verdict, from the two legs' observations. PURE.
///
/// The order matters: leg 1's refusal short-circuits (leg 2 would only repeat
/// it), a mint failure is a FAILURE rather than a skip (a skip reads as "nothing
/// to check here", which is the opposite of "your session expired"), and a frame
/// beats every other observation because a server that talked to us has passed.
pub fn classify_probe(http: &LegResult, ws: Option<&WsObservation>) -> ProbeVerdict {
    if !http.ok {
        return match http.status {
            Some(401 | 403) => ProbeVerdict::AuthRequired,
            _ => ProbeVerdict::Unreachable,
        };
    }

    let Some(ws) = ws else {
        return ProbeVerdict::Ok;
    };

    if ws.skipped_no_token {
        return ProbeVerdict::SkippedNoToken;
    }

    if ws.mint_failed {
        return if ws.mint_unauthorized {
            ProbeVerdict::AuthRequired
        } else {
            ProbeVerdict::WsUnreachable
        };
    }

    if ws.frame {
        return ProbeVerdict::Ok;
    }

    if ws.closed_after_open {
        return ProbeVerdict::CredentialRejected;
    }

    if ws.closed_before_open {
        return ProbeVerdict::WsUnreachable;
    }

    if ws.opened {
        return ProbeVerdict::Ok;
    }

    if ws.timed_out {
        return ProbeVerdict::Timeout;
    }

    ProbeVerdict::WsUnreachable
}

/// Is this verdict a pass? `SkippedNoToken` is: nothing was wrong, there was
/// simply nothing to check.
pub fn verdict_is_ok(verdict: ProbeVerdict) -> bool {
    matches!(verdict, ProbeVerdict::Ok | ProbeVerdict::SkippedNoToken)
}

/// Leg 1 — `GET {base}/api/status`, through the shared reqwest client so the
/// connection's own headers and token ride with it (`ConnectionAuthTable`).
pub async fn probe_http_leg(app: &AppHandle, base_url: &str) -> (LegResult, serde_json::Value) {
    let started = Instant::now();
    let url = format!("{}/api/status", base_url.trim_end_matches('/'));

    match crate::transport::probe_get_json(app, &url, Duration::from_millis(STATUS_TIMEOUT_MS))
        .await
    {
        Ok((status, body)) => (
            LegResult {
                ok: (200..300).contains(&status),
                status: Some(status),
                ms: started.elapsed().as_millis() as u64,
                error: None,
            },
            body,
        ),
        Err(error) => (
            LegResult {
                ok: false,
                status: None,
                ms: started.elapsed().as_millis() as u64,
                error: Some(error),
            },
            serde_json::Value::Null,
        ),
    }
}

/// Leg 2 — a real WS upgrade, watched for `READY_GRACE_MS` after it opens.
pub async fn probe_ws_leg(
    app: &AppHandle,
    ws_url: &str,
    headers: Vec<(String, String)>,
) -> (LegResult, WsObservation) {
    let started = Instant::now();

    match crate::transport::probe_ws(
        app,
        ws_url,
        headers,
        Duration::from_millis(CONNECT_TIMEOUT_MS),
        Duration::from_millis(READY_GRACE_MS),
    )
    .await
    {
        Ok(observation) => (
            LegResult {
                ok: observation.opened && !observation.closed_after_open,
                status: None,
                ms: started.elapsed().as_millis() as u64,
                error: None,
            },
            observation,
        ),
        Err(error) => (
            LegResult {
                ok: false,
                status: None,
                ms: started.elapsed().as_millis() as u64,
                error: Some(error),
            },
            WsObservation {
                closed_before_open: true,
                ..WsObservation::default()
            },
        ),
    }
}

/// Which base URL a probe can even address. `ssh` and `local` are reached
/// through a tunnel or a child process that only exists while connected, so a
/// stored descriptor alone cannot be probed — reporting that is honest, and
/// dialling one from a probe is the "stale key → respawn every 5 s → ECONNRESET"
/// lesson desktop learned the hard way.
pub fn probe_base_url(connection: &Connection) -> Result<String, ConnectionsError> {
    match connection.kind {
        ConnectionKind::Cloud | ConnectionKind::Remote => connection
            .url
            .clone()
            .ok_or_else(|| ConnectionsError::invalid("this gateway has no URL to test")),
        ConnectionKind::Local | ConnectionKind::Ssh => Err(ConnectionsError::invalid(
            "this gateway is reached by connecting to it, so there is nothing to test from here",
        )),
    }
}

/// `?token=` / `?ticket=` never appears in a JS value: the auth param is decided
/// here, next to the credential.
pub fn ws_url_for(base_url: &str, auth: Option<(&str, &str)>) -> String {
    let scheme_swapped = if let Some(rest) = base_url.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = base_url.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        base_url.to_string()
    };

    let base = format!("{}/api/ws", scheme_swapped.trim_end_matches('/'));

    match auth {
        Some((name, value)) => format!(
            "{base}?{name}={}",
            percent_encoding::utf8_percent_encode(value, percent_encoding::NON_ALPHANUMERIC)
        ),
        None => base,
    }
}

/// Which auth param leg 2 needs, given what the registry holds.
pub fn ws_auth_plan(auth_mode: AuthMode, has_token: bool) -> WsAuthPlan {
    match auth_mode {
        AuthMode::Token if has_token => WsAuthPlan::Token,
        AuthMode::Token => WsAuthPlan::SkipNoToken,
        AuthMode::Oauth => WsAuthPlan::Ticket,
        AuthMode::None => WsAuthPlan::Open,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WsAuthPlan {
    Open,
    Token,
    Ticket,
    SkipNoToken,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn http_ok() -> LegResult {
        LegResult {
            ok: true,
            status: Some(200),
            ms: 12,
            error: None,
        }
    }

    #[test]
    fn desktop_constants_are_pinned() {
        // Mirrored in `src/store/connections.ts`'s PROBE_TIMINGS and asserted
        // there too: a change on one side alone would silently re-tune the
        // credential-rejected window.
        assert_eq!(CONNECT_TIMEOUT_MS, 10_000);
        assert_eq!(READY_GRACE_MS, 750);
        assert_eq!(STATUS_TIMEOUT_MS, 8_000);
    }

    #[test]
    fn both_legs_ok_is_ok() {
        let ws = WsObservation {
            opened: true,
            ..WsObservation::default()
        };

        assert_eq!(classify_probe(&http_ok(), Some(&ws)), ProbeVerdict::Ok);
        assert!(verdict_is_ok(classify_probe(&http_ok(), Some(&ws))));
    }

    #[test]
    fn open_then_close_inside_the_grace_is_a_rejected_credential() {
        let ws = WsObservation {
            opened: true,
            closed_after_open: true,
            ..WsObservation::default()
        };

        assert_eq!(
            classify_probe(&http_ok(), Some(&ws)),
            ProbeVerdict::CredentialRejected
        );
        assert!(!verdict_is_ok(ProbeVerdict::CredentialRejected));
    }

    #[test]
    fn a_close_before_open_is_an_unreachable_socket() {
        let ws = WsObservation {
            closed_before_open: true,
            ..WsObservation::default()
        };

        assert_eq!(
            classify_probe(&http_ok(), Some(&ws)),
            ProbeVerdict::WsUnreachable
        );
    }

    #[test]
    fn nothing_at_all_is_a_timeout() {
        let ws = WsObservation {
            timed_out: true,
            ..WsObservation::default()
        };

        assert_eq!(classify_probe(&http_ok(), Some(&ws)), ProbeVerdict::Timeout);
    }

    #[test]
    fn a_frame_wins_immediately_even_over_a_close() {
        let ws = WsObservation {
            opened: true,
            frame: true,
            closed_after_open: true,
            ..WsObservation::default()
        };

        assert_eq!(classify_probe(&http_ok(), Some(&ws)), ProbeVerdict::Ok);
    }

    #[test]
    fn leg_one_401_is_auth_required_and_leg_two_is_not_consulted() {
        let http = LegResult {
            ok: false,
            status: Some(401),
            ms: 5,
            error: None,
        };

        assert_eq!(classify_probe(&http, None), ProbeVerdict::AuthRequired);
        // Even a perfect leg 2 cannot override it — the sign-in is what is missing.
        let ws = WsObservation {
            opened: true,
            frame: true,
            ..WsObservation::default()
        };
        assert_eq!(classify_probe(&http, Some(&ws)), ProbeVerdict::AuthRequired);
    }

    #[test]
    fn leg_one_failure_without_a_status_is_unreachable() {
        let http = LegResult {
            ok: false,
            status: None,
            ms: 8000,
            error: Some("connection refused".to_string()),
        };

        assert_eq!(classify_probe(&http, None), ProbeVerdict::Unreachable);
    }

    #[test]
    fn token_mode_with_no_token_is_a_genuine_skip() {
        let ws = WsObservation {
            skipped_no_token: true,
            ..WsObservation::default()
        };

        assert_eq!(
            classify_probe(&http_ok(), Some(&ws)),
            ProbeVerdict::SkippedNoToken
        );
        assert!(verdict_is_ok(ProbeVerdict::SkippedNoToken));
        assert_eq!(
            ws_auth_plan(AuthMode::Token, false),
            WsAuthPlan::SkipNoToken
        );
        assert_eq!(ws_auth_plan(AuthMode::Token, true), WsAuthPlan::Token);
    }

    #[test]
    fn a_mint_failure_is_a_failure_not_a_skip() {
        let ws = WsObservation {
            mint_failed: true,
            ..WsObservation::default()
        };

        assert_eq!(
            classify_probe(&http_ok(), Some(&ws)),
            ProbeVerdict::WsUnreachable
        );
        assert!(!verdict_is_ok(classify_probe(&http_ok(), Some(&ws))));

        let unauthorized = WsObservation {
            mint_failed: true,
            mint_unauthorized: true,
            ..WsObservation::default()
        };

        assert_eq!(
            classify_probe(&http_ok(), Some(&unauthorized)),
            ProbeVerdict::AuthRequired
        );
    }

    #[test]
    fn ws_url_swaps_the_scheme_and_encodes_the_auth_param() {
        assert_eq!(
            ws_url_for("https://gw.example.com", None),
            "wss://gw.example.com/api/ws"
        );
        assert_eq!(
            ws_url_for("http://127.0.0.1:9119/", None),
            "ws://127.0.0.1:9119/api/ws"
        );
        assert_eq!(
            ws_url_for("http://gw", Some(("token", "a b/c"))),
            "ws://gw/api/ws?token=a%20b%2Fc"
        );
    }

    #[test]
    fn only_addressable_kinds_can_be_probed_from_a_descriptor() {
        let mut connection = super::super::registry::local_connection();

        assert!(probe_base_url(&connection).is_err());

        connection.kind = ConnectionKind::Remote;
        connection.url = Some("http://gw".to_string());
        assert_eq!(probe_base_url(&connection).expect("remote"), "http://gw");

        connection.kind = ConnectionKind::Ssh;
        assert!(probe_base_url(&connection).is_err());
    }
}
