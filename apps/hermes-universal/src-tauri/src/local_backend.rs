//! Local gateway backend spawn (E3, desktop-only [GATE]).
//!
//! Desktop can run a bundled Hermes backend as a child process; a phone cannot,
//! so every command here is compiled to an `unsupported_platform` stub on mobile.
//!
//! Mirrors the desktop (Electron) contract: spawn `hermes serve --host 127.0.0.1
//! --port 0` (OS-assigned ephemeral port), hand the child a random session token
//! via `HERMES_DASHBOARD_SESSION_TOKEN`, and detect readiness in two stages —
//! (1) the child prints `HERMES_(BACKEND|DASHBOARD)_READY port=<N>` on stdout once
//! uvicorn binds, then (2) `GET {base}/api/status` succeeds. Returns a token-mode
//! connection descriptor.

use serde::Serialize;
#[cfg(desktop)]
use tauri::{AppHandle, Manager};
use tokio::sync::Mutex;

#[cfg(desktop)]
use crate::tunnels::{
    FailureKind, Hold, SlotKind, SlotSpec, TunnelError, LOCAL_INSTANCE_KEY, LOCAL_SLOT,
};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LocalBackend {
    base_url: String,
    token: String,
    ws_url: String,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LocalBackendStatus {
    running: bool,
    base_url: Option<String>,
}

#[cfg(desktop)]
mod imp {
    use super::*;
    use std::process::Stdio;
    use std::sync::Arc;
    use std::time::Duration;

    use tokio::io::{AsyncBufReadExt, BufReader};
    use tokio::process::{Child, Command};

    use crate::backend_log::{self, BackendLog};

    pub struct Running {
        pub child: Child,
        pub backend: LocalBackend,
        /// Which spawn this is, so a death watcher never reports a successor.
        pub serial: u64,
    }

    /// The one live local backend (at most one at a time), shared by the
    /// primary and every background lease (MJXHRM-592).
    pub struct LocalBackendState {
        pub running: Mutex<Option<Running>>,
        serial: std::sync::atomic::AtomicU64,
        /// Everything the child prints, redacted (gap 10).
        pub log: Arc<BackendLog>,
    }

    impl Default for LocalBackendState {
        fn default() -> Self {
            Self {
                running: Mutex::new(None),
                serial: Default::default(),
                log: Arc::new(BackendLog::at_hermes_home()),
            }
        }
    }

    /// How often the watcher checks whether the child exited on its own.
    const CHILD_WATCH_INTERVAL: Duration = Duration::from_secs(5);

    fn random_token() -> String {
        let mut buf = [0u8; 32];
        // getrandom is infallible on every desktop OS we target.
        getrandom::getrandom(&mut buf).ok();
        buf.iter().map(|b| format!("{b:02x}")).collect()
    }

    /// Pin HERMES_HOME the way desktop does so the spawned backend shares state
    /// with the rest of the install. Delegates to the shared resolver in
    /// `plugins.rs`, which honours an explicit HERMES_HOME before falling back to
    /// the platform default — previously this computed the default unconditionally,
    /// so a user running with a custom HERMES_HOME had the spawned backend and the
    /// plugin root disagree. Falls back to the child's inherited env when
    /// unresolvable.
    fn hermes_home() -> Option<String> {
        crate::plugins::hermes_home().map(|p| p.to_string_lossy().to_string())
    }

    /// Parse `HERMES_(BACKEND|DASHBOARD)_READY port=<N>` → the announced port.
    pub fn parse_ready_port(line: &str) -> Option<u16> {
        let rest = line
            .strip_prefix("HERMES_BACKEND_READY port=")
            .or_else(|| line.strip_prefix("HERMES_DASHBOARD_READY port="))?;
        rest.trim().parse::<u16>().ok()
    }

    async fn wait_for_status(base: &str, token: &str) -> Result<(), String> {
        let client = reqwest::Client::new();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(45);
        loop {
            if tokio::time::Instant::now() >= deadline {
                return Err("backend did not become ready within 45s".to_string());
            }
            let ok = client
                .get(format!("{base}/api/status"))
                .header("X-Hermes-Session-Token", token)
                .timeout(Duration::from_secs(3))
                .send()
                .await
                .map(|r| r.status().is_success())
                .unwrap_or(false);
            if ok {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }

    /// Start `hermes serve` and wait until it answers. Stores nothing.
    ///
    /// A binary that cannot be started at all is terminal; anything after it
    /// started is worth retrying.
    async fn start(
        profile: Option<String>,
        log: &Arc<BackendLog>,
    ) -> Result<(Child, LocalBackend), (FailureKind, String)> {
        let transient = |message: String| (FailureKind::Transient, log.with_tail(message));
        let token = random_token();
        let program = std::env::var("HERMES_BIN").unwrap_or_else(|_| "hermes".to_string());

        let mut args: Vec<String> = vec![
            "serve".into(),
            "--host".into(),
            "127.0.0.1".into(),
            "--port".into(),
            "0".into(),
        ];
        if let Some(p) = profile.as_deref().filter(|p| !p.is_empty()) {
            // Profile flag goes before the subcommand, matching the desktop CLI.
            args.splice(0..0, ["--profile".to_string(), p.to_string()]);
        }

        let mut cmd = Command::new(&program);
        cmd.args(&args)
            .env("HERMES_DASHBOARD_SESSION_TOKEN", &token)
            .env("HERMES_DESKTOP", "1")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if let Some(home) = hermes_home() {
            cmd.env("HERMES_HOME", home);
        }

        let mut child = cmd.spawn().map_err(|e| {
            (
                FailureKind::HermesNotFound,
                format!("could not start `{program}`: {e}. Is the Hermes CLI installed / on PATH?"),
            )
        })?;

        // Stage 1: wait (≤90s) for the port announcement on stdout.
        let port = announce(&mut child, log).await.map_err(transient)?;

        let base_url = format!("http://127.0.0.1:{port}");

        // Stage 2: HTTP readiness.
        wait_for_status(&base_url, &token)
            .await
            .map_err(transient)?;

        let backend = LocalBackend {
            base_url: base_url.clone(),
            token: token.clone(),
            ws_url: format!(
                "{}/api/ws?token={token}",
                base_url.replacen("http", "ws", 1)
            ),
        };

        Ok((child, backend))
    }

    /// Read the ready line, draining both streams from the moment of spawn.
    ///
    /// stderr is drained on its own task from the start: a backend that writes
    /// more than a pipe's worth before it is ready would otherwise block forever
    /// and never print the line we are waiting for.
    pub(super) async fn announce(child: &mut Child, log: &Arc<BackendLog>) -> Result<u16, String> {
        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(backend_log::drain(stderr, Arc::clone(log)));
        }

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "failed to capture backend stdout".to_string())?;
        let mut lines = BufReader::new(stdout).lines();

        let port = tokio::time::timeout(Duration::from_secs(90), async {
            while let Ok(Some(line)) = lines.next_line().await {
                log.push(&line);

                if let Some(port) = parse_ready_port(&line) {
                    return Some(port);
                }
            }
            None
        })
        .await
        .map_err(|_| "timed out waiting for the backend to announce its port".to_string())?
        .ok_or_else(|| "backend exited before announcing a port".to_string())?;

        let rest = lines.into_inner();
        let log = Arc::clone(log);

        tokio::spawn(async move { backend_log::drain(rest, log).await });

        Ok(port)
    }

    /// Replace whatever child is held with a fresh one and publish its token
    /// for leases. The caller reports the outcome to the tunnel book.
    pub async fn respawn(
        app: &AppHandle,
        state: &LocalBackendState,
        profile: Option<String>,
    ) -> Result<LocalBackend, TunnelError> {
        kill(app, state).await;

        match start(profile, &state.log).await {
            Ok((child, backend)) => {
                let serial = state
                    .serial
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);

                app.state::<crate::transport::TransportState>()
                    .set_tunnel_auth(
                        &backend.base_url,
                        crate::transport::ConnectionAuth {
                            connection_id: crate::connections::registry::LOCAL_CONNECTION_ID
                                .to_string(),
                            token: Some(backend.token.clone()),
                            headers: Vec::new(),
                        },
                    );

                *state.running.lock().await = Some(Running {
                    child,
                    backend: backend.clone(),
                    serial,
                });

                watch_child(app.clone(), serial);

                Ok(backend)
            }
            Err((kind, message)) => Err(TunnelError::new(kind, message)),
        }
    }

    /// `respawn` for the primary's own commands, which report it themselves.
    pub async fn respawn_reported(
        app: &AppHandle,
        state: &LocalBackendState,
        profile: Option<String>,
    ) -> Result<LocalBackend, String> {
        let result = respawn(app, state, profile).await;

        crate::tunnels::finish_dial(
            app,
            LOCAL_SLOT,
            result
                .as_ref()
                .map(|backend| backend.base_url.clone())
                .map_err(Clone::clone),
        );

        result.map_err(|error| error.message)
    }

    /// Notice the child exiting on its own and tell the tunnel book.
    fn watch_child(app: AppHandle, serial: u64) {
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(CHILD_WATCH_INTERVAL).await;

                let state = app.state::<LocalBackendState>();
                let mut guard = state.running.lock().await;

                let Some(running) = guard.as_mut().filter(|running| running.serial == serial)
                else {
                    // Killed on purpose, or replaced.
                    return;
                };

                if matches!(running.child.try_wait(), Ok(None)) {
                    continue;
                }

                if let Some(dead) = guard.take() {
                    app.state::<crate::transport::TransportState>()
                        .forget_tunnel_auth(&dead.backend.base_url);
                }

                drop(guard);
                log::warn!(
                    "{}",
                    state
                        .log
                        .with_tail("[tunnel] the local backend exited on its own")
                );
                crate::tunnels::on_dead(&app, LOCAL_SLOT);

                return;
            }
        });
    }

    /// Whether the held child is still running.
    pub async fn alive(state: &LocalBackendState) -> bool {
        state
            .running
            .lock()
            .await
            .as_mut()
            .is_some_and(|running| matches!(running.child.try_wait(), Ok(None)))
    }

    pub async fn current(state: &LocalBackendState) -> Option<LocalBackend> {
        state
            .running
            .lock()
            .await
            .as_ref()
            .map(|running| running.backend.clone())
    }

    /// Kill the child. Its credential is forgotten before the port is freed.
    pub async fn kill(app: &AppHandle, state: &LocalBackendState) {
        if let Some(mut running) = state.running.lock().await.take() {
            app.state::<crate::transport::TransportState>()
                .forget_tunnel_auth(&running.backend.base_url);
            let _ = running.child.start_kill();
        }
    }

    pub async fn status(state: &LocalBackendState) -> LocalBackendStatus {
        match &*state.running.lock().await {
            Some(r) => LocalBackendStatus {
                running: true,
                base_url: Some(r.backend.base_url.clone()),
            },
            None => LocalBackendStatus::default(),
        }
    }
}

// --------------------------------------------------------------------------
// Desktop: real implementation.
// --------------------------------------------------------------------------
#[cfg(desktop)]
pub use imp::LocalBackendState;

/// The base URL of the local child, if one is ALREADY running.
///
/// The registry's roster (MJXHRM-446) asks before enumerating a `local` source,
/// so a background poll can never spawn a backend the user did not ask for.
#[cfg(desktop)]
pub async fn running_base_url(state: &LocalBackendState) -> Option<String> {
    imp::status(state).await.base_url
}

#[cfg(mobile)]
pub async fn running_base_url(_state: &LocalBackendState) -> Option<String> {
    None
}

/// Kill the spawned `hermes serve` child, for callers that are not a command.
///
/// The tray's Keep Running row is the one such caller: turning background mode
/// off means the process is about to stop being resident, and a child gateway
/// left behind would outlive the app that spawned it with nothing in the UI able
/// to reach it. A hard stop: every lease on the child ends with it.
#[cfg(desktop)]
pub async fn stop(app: &AppHandle) {
    crate::tunnels::remove_slot(app, LOCAL_SLOT);
    imp::kill(app, &app.state::<imp::LocalBackendState>()).await;
}

/// The tunnel book's teardown and exit door. No-op on mobile.
#[cfg(desktop)]
pub(crate) async fn kill_child(app: &AppHandle) {
    if let Some(state) = app.try_state::<imp::LocalBackendState>() {
        imp::kill(app, &state).await;
    }
}

#[cfg(mobile)]
pub(crate) async fn kill_child(_app: &tauri::AppHandle) {}

/// Spawn the child for a background lease (MJXHRM-592).
#[cfg(desktop)]
pub(crate) async fn dial_tunnel(
    app: &AppHandle,
    profile: Option<String>,
) -> Result<String, TunnelError> {
    let state = app.state::<imp::LocalBackendState>();

    imp::respawn(app, &state, profile)
        .await
        .map(|backend| backend.base_url)
}

#[cfg(mobile)]
pub(crate) async fn dial_tunnel(
    _app: &tauri::AppHandle,
    _profile: Option<String>,
) -> Result<String, crate::tunnels::TunnelError> {
    Err(crate::tunnels::TunnelError::new(
        crate::tunnels::FailureKind::UnsupportedPlatform,
        "unsupported_platform",
    ))
}

/// The active connection's local backend.
///
/// A child that is already running is ADOPTED whatever profile it was launched
/// as — requests carry their own profile, and a background lease may be riding
/// it. Only `local_backend_restart` respawns a live child.
#[cfg(desktop)]
#[tauri::command]
pub async fn local_backend_spawn(
    app: AppHandle,
    state: tauri::State<'_, imp::LocalBackendState>,
    profile: Option<String>,
) -> Result<LocalBackend, String> {
    let alive = imp::alive(&state).await;
    let spec = SlotSpec {
        connection_id: crate::connections::registry::LOCAL_CONNECTION_ID.to_string(),
        kind: SlotKind::Local,
        instance_key: LOCAL_INSTANCE_KEY.to_string(),
        profile: profile.clone(),
    };

    match crate::tunnels::hold_primary(&app, LOCAL_SLOT, spec, alive) {
        Hold::Reuse => {}
        Hold::Join(rx) => {
            crate::tunnels::wait(rx).await.map_err(|e| e.message)?;
        }
        Hold::Dial => return imp::respawn_reported(&app, &state, profile).await,
    }

    imp::current(&state)
        .await
        .ok_or_else(|| "the local backend stopped before it could be adopted".to_string())
}

/// "Restart as <profile>": respawn the child in place. Every lease stays held
/// and reconnects on `tunnel://local/changed`.
#[cfg(desktop)]
#[tauri::command]
pub async fn local_backend_restart(
    app: AppHandle,
    state: tauri::State<'_, imp::LocalBackendState>,
    profile: Option<String>,
) -> Result<LocalBackend, String> {
    if !crate::tunnels::begin_restart(&app, LOCAL_SLOT, profile.clone()) {
        return local_backend_spawn(app, state, profile).await;
    }

    imp::respawn_reported(&app, &state, profile).await
}

#[cfg(desktop)]
#[tauri::command]
pub async fn local_backend_status(
    state: tauri::State<'_, imp::LocalBackendState>,
) -> Result<LocalBackendStatus, String> {
    Ok(imp::status(&state).await)
}

/// Release the active connection's hold. The child keeps running while a
/// background lease holds it.
#[cfg(desktop)]
#[tauri::command]
pub async fn local_backend_stop(
    app: AppHandle,
    state: tauri::State<'_, imp::LocalBackendState>,
) -> Result<(), String> {
    if !crate::tunnels::release_primary(&app, LOCAL_SLOT).await {
        imp::kill(&app, &state).await;
    }

    Ok(())
}

/// The hard stop, for quitting: kills the child whoever holds it.
#[cfg(desktop)]
#[tauri::command]
pub async fn local_backend_kill(app: AppHandle) -> Result<(), String> {
    stop(&app).await;

    Ok(())
}

// --------------------------------------------------------------------------
// Mobile: no local spawn — the UI gates this off, but the commands still exist
// so a stray call returns a clear error rather than a missing-command panic.
// --------------------------------------------------------------------------
#[cfg(mobile)]
#[derive(Default)]
pub struct LocalBackendState;

#[cfg(mobile)]
#[tauri::command]
pub async fn local_backend_spawn(
    _state: tauri::State<'_, LocalBackendState>,
    _profile: Option<String>,
) -> Result<LocalBackend, String> {
    Err("unsupported_platform".to_string())
}

#[cfg(mobile)]
#[tauri::command]
pub async fn local_backend_status(
    _state: tauri::State<'_, LocalBackendState>,
) -> Result<LocalBackendStatus, String> {
    Ok(LocalBackendStatus::default())
}

#[cfg(mobile)]
#[tauri::command]
pub async fn local_backend_stop(_state: tauri::State<'_, LocalBackendState>) -> Result<(), String> {
    Err("unsupported_platform".to_string())
}

#[cfg(mobile)]
#[tauri::command]
pub async fn local_backend_restart(
    _state: tauri::State<'_, LocalBackendState>,
    _profile: Option<String>,
) -> Result<LocalBackend, String> {
    Err("unsupported_platform".to_string())
}

#[cfg(mobile)]
#[tauri::command]
pub async fn local_backend_kill() -> Result<(), String> {
    Err("unsupported_platform".to_string())
}

#[cfg(all(test, desktop))]
mod tests {
    use super::imp::parse_ready_port;

    /// A backend that writes a megabyte to stderr before it is ready must still
    /// be seen as ready: nobody reading stderr blocks it on a full pipe.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_chatty_backend_still_announces_its_port() {
        let mut child = tokio::process::Command::new("sh")
            .arg("-c")
            .arg("yes 'some backend noise on stderr' | head -c 1048576 >&2; echo HERMES_BACKEND_READY port=4321")
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .expect("sh runs");
        let log = std::sync::Arc::new(crate::backend_log::BackendLog::new(None));

        let port = tokio::time::timeout(
            std::time::Duration::from_secs(20),
            super::imp::announce(&mut child, &log),
        )
        .await
        .expect("the ready line arrives while stderr is drained");

        assert_eq!(port, Ok(4321));
    }

    #[test]
    fn parses_backend_and_dashboard_ready_lines() {
        assert_eq!(
            parse_ready_port("HERMES_BACKEND_READY port=54321"),
            Some(54321)
        );
        assert_eq!(
            parse_ready_port("HERMES_DASHBOARD_READY port=8788"),
            Some(8788)
        );
    }

    #[test]
    fn ignores_unrelated_lines() {
        assert_eq!(parse_ready_port("INFO: uvicorn running"), None);
        assert_eq!(parse_ready_port("HERMES_BACKEND_READY port=notaport"), None);
    }
}
