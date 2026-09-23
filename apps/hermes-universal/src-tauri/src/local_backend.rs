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
    Dial, FailureKind, Hold, SlotKind, SlotSpec, TunnelError, LOCAL_INSTANCE_KEY, LOCAL_SLOT,
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

    use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
    use tokio::process::{Child, Command};
    use tokio::sync::oneshot;
    use tokio_util::sync::CancellationToken;

    use crate::backend_log::{self, BackendLog};

    pub type Drain = tokio::task::JoinHandle<()>;

    /// How long a started child gets to print its port.
    const ANNOUNCE_TIMEOUT: Duration = Duration::from_secs(90);

    /// The one local child, from the moment it is spawned (MJXHRM-592). A child
    /// that lived only in a task's future would outlive quit: the runtime and
    /// managed state are never dropped at exit, so `kill_on_drop` never fires.
    pub enum Entry {
        /// Spawned by dial `dial`, not yet answering. No credential is set.
        Starting {
            dial: u64,
            child: Child,
            drains: Vec<Drain>,
        },
        /// Promoted and serving. `spawn` tells a death watcher which child it is.
        Running {
            spawn: u64,
            child: Child,
            backend: LocalBackend,
            drains: Vec<Drain>,
        },
    }

    #[derive(Default)]
    pub struct Local {
        pub entry: Option<Entry>,
        /// Set by quit's kill: nothing spawns after it.
        pub closed: bool,
    }

    impl Local {
        fn running(&mut self) -> Option<(&mut Child, &LocalBackend)> {
            match &mut self.entry {
                Some(Entry::Running { child, backend, .. }) => Some((child, backend)),
                _ => None,
            }
        }
    }

    /// The one local backend (at most one at a time), shared by the primary and
    /// every background lease (MJXHRM-592). `running` is the L lock.
    pub struct LocalBackendState {
        pub running: Mutex<Local>,
        serial: std::sync::atomic::AtomicU64,
        /// Everything the child prints, redacted (gap 10).
        pub log: Arc<BackendLog>,
    }

    impl Default for LocalBackendState {
        fn default() -> Self {
            Self {
                running: Mutex::new(Local::default()),
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
    /// the platform default. Falls back to the child's inherited env when
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

    /// Always `--profile default`: the backend's unified server, which serves
    /// every profile by the `profile` parameter, so a profile switch never needs
    /// a respawn. The pin is the backend's own re-exec shape, which keeps the
    /// sticky active-profile file from choosing the launch profile
    /// (`hermes_cli/main_dashboard.py`). The flag goes before the subcommand.
    pub(super) fn launch_args() -> Vec<String> {
        [
            "--profile",
            "default",
            "serve",
            "--host",
            "127.0.0.1",
            "--port",
            "0",
        ]
        .map(String::from)
        .to_vec()
    }

    /// The child's environment. `HERMES_PARENT_PID` arms the backend's
    /// parent-death watchdog (`hermes_cli/web_server_lifecycle.py`, upstream
    /// desktop's `parent-process-identity.ts`), the backstop for an app that dies
    /// without running its exit (a crash, SIGKILL). PID-only; a backend without
    /// the watchdog ignores it.
    pub(super) fn launch_env(token: &str) -> Vec<(String, String)> {
        let mut env = vec![
            (
                "HERMES_DASHBOARD_SESSION_TOKEN".to_string(),
                token.to_string(),
            ),
            ("HERMES_DESKTOP".to_string(), "1".to_string()),
            (
                "HERMES_PARENT_PID".to_string(),
                std::process::id().to_string(),
            ),
        ];

        if let Some(home) = hermes_home() {
            env.push(("HERMES_HOME".to_string(), home));
        }

        env
    }

    fn command(program: &str, token: &str) -> Command {
        let mut cmd = Command::new(program);

        cmd.args(launch_args())
            .envs(launch_env(token))
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        cmd
    }

    /// Read the child's stdout to its end, feeding the log, and report the port
    /// its ready line announces. A drain from the moment of spawn: a starting
    /// child's last lines are as much the log's as a running one's.
    pub async fn drain_stdout<R: AsyncRead + Unpin>(
        stream: R,
        log: Arc<BackendLog>,
        ready: oneshot::Sender<u16>,
    ) {
        let mut ready = Some(ready);
        let mut lines = BufReader::new(stream).lines();

        while let Ok(Some(line)) = lines.next_line().await {
            log.push(&line);

            if let Some(port) = parse_ready_port(&line) {
                if let Some(ready) = ready.take() {
                    let _ = ready.send(port);
                }
            }
        }
    }

    #[derive(Debug, PartialEq, Eq)]
    pub enum SpawnRefusal {
        /// Quit closed the state.
        Closed,
        /// The slot no longer waits on this dial.
        NotCurrent,
        Cancelled,
        /// The program could not be started at all.
        Failed(String),
    }

    /// Spawn the child for dial `dial` and record it, in one L section: no child
    /// exists that the state does not hold. The caller holds the install lock.
    ///
    /// Refused, running nothing, once quit closed the state, when the slot no
    /// longer waits on the dial, or when its cancel has landed — checked after
    /// taking L, so a cancel that arrived while this waited is seen. Whatever
    /// child was there before is killed first, its credential forgotten first.
    /// Both pipes are drained from here on; the stdout drain reports the port.
    pub async fn spawn_recorded(
        state: &Mutex<Local>,
        dial: u64,
        is_current: impl FnOnce() -> bool,
        cancel: &CancellationToken,
        forget: &(dyn Fn(&str) + Sync),
        spawn: impl FnOnce() -> std::io::Result<Child>,
        log: &Arc<BackendLog>,
    ) -> Result<oneshot::Receiver<u16>, SpawnRefusal> {
        let mut local = state.lock().await;

        if local.closed {
            return Err(SpawnRefusal::Closed);
        }

        if !is_current() {
            return Err(SpawnRefusal::NotCurrent);
        }

        if cancel.is_cancelled() {
            return Err(SpawnRefusal::Cancelled);
        }

        let _ = kill_entry(&mut local, false, forget);

        let mut child = spawn().map_err(|e| SpawnRefusal::Failed(e.to_string()))?;
        let (ready_tx, ready_rx) = oneshot::channel();
        let mut drains = Vec::new();

        if let Some(stderr) = child.stderr.take() {
            drains.push(tokio::spawn(backend_log::drain(stderr, Arc::clone(log))));
        }

        if let Some(stdout) = child.stdout.take() {
            drains.push(tokio::spawn(drain_stdout(
                stdout,
                Arc::clone(log),
                ready_tx,
            )));
        }

        local.entry = Some(Entry::Starting {
            dial,
            child,
            drains,
        });

        Ok(ready_rx)
    }

    /// Kill whatever child the state holds, starting or running, and hand back
    /// its drains. A running child's credential is forgotten before its port is
    /// freed. `close`: quit — nothing spawns after this.
    pub fn kill_entry(
        local: &mut Local,
        close: bool,
        forget: &(dyn Fn(&str) + Sync),
    ) -> Vec<Drain> {
        if close {
            local.closed = true;
        }

        match local.entry.take() {
            None => Vec::new(),
            Some(Entry::Starting {
                mut child, drains, ..
            }) => {
                let _ = child.start_kill();

                drains
            }
            Some(Entry::Running {
                mut child,
                backend,
                drains,
                ..
            }) => {
                forget(&backend.base_url);
                let _ = child.start_kill();

                drains
            }
        }
    }

    /// A start that will not be promoted — cancelled, failed, exited on its own
    /// or superseded — ends its OWN child only. A successor's start is left be.
    pub fn end_own_start(local: &mut Local, dial: u64) -> Option<Vec<Drain>> {
        match local.entry.take() {
            Some(Entry::Starting {
                dial: own,
                mut child,
                drains,
            }) if own == dial => {
                let _ = child.start_kill();

                Some(drains)
            }
            other => {
                local.entry = other;

                None
            }
        }
    }

    /// Starting → Running, only while the slot still waits on this dial and the
    /// state still holds this dial's own start. The credential is set here and
    /// nowhere else.
    pub fn promote(
        local: &mut Local,
        dial: u64,
        is_current: impl FnOnce() -> bool,
        spawn: u64,
        backend: LocalBackend,
        set_auth: impl FnOnce(&LocalBackend),
    ) -> bool {
        match local.entry.take() {
            Some(Entry::Starting {
                dial: own,
                child,
                drains,
            }) if own == dial && is_current() => {
                set_auth(&backend);
                local.entry = Some(Entry::Running {
                    spawn,
                    child,
                    backend,
                    drains,
                });

                true
            }
            other => {
                local.entry = other;

                false
            }
        }
    }

    /// Wait for the started child to announce its port and answer, racing the
    /// dial's cancel at every step: a removal, a supersede or quit never waits
    /// out a 135 s cold start.
    pub async fn await_ready(
        cancel: &CancellationToken,
        ready: oneshot::Receiver<u16>,
        token: &str,
    ) -> Result<LocalBackend, (FailureKind, String)> {
        let cancelled = || {
            (
                FailureKind::Cancelled,
                "the local backend start was cancelled".to_string(),
            )
        };

        let port = crate::ssh::race_cancel(cancel, tokio::time::timeout(ANNOUNCE_TIMEOUT, ready))
            .await
            .ok_or_else(cancelled)?
            .map_err(|_| {
                (
                    FailureKind::Transient,
                    "timed out waiting for the backend to announce its port".to_string(),
                )
            })?
            .map_err(|_| {
                (
                    FailureKind::Transient,
                    "backend exited before announcing a port".to_string(),
                )
            })?;

        let base_url = format!("http://127.0.0.1:{port}");

        crate::ssh::race_cancel(cancel, wait_for_status(&base_url, token))
            .await
            .ok_or_else(cancelled)?
            .map_err(|message| (FailureKind::Transient, message))?;

        Ok(LocalBackend {
            base_url: base_url.clone(),
            token: token.to_string(),
            ws_url: format!(
                "{}/api/ws?token={token}",
                base_url.replacen("http", "ws", 1)
            ),
        })
    }

    fn superseded() -> TunnelError {
        TunnelError::new(
            FailureKind::Transient,
            "a newer start of the local backend replaced this one",
        )
    }

    fn cancelled() -> TunnelError {
        TunnelError::new(
            FailureKind::Cancelled,
            "the local backend start was cancelled",
        )
    }

    /// Run a local dial: wait out a superseded dial (racing this one's cancel),
    /// then start, record and promote a child. Settles the dial either way.
    pub async fn run_dial(
        app: &AppHandle,
        state: &LocalBackendState,
        mut dial: Dial,
    ) -> Result<LocalBackend, TunnelError> {
        let cancel = dial.cancel.clone();

        if crate::ssh::race_cancel(
            &cancel,
            crate::tunnels::prepare(app, &mut dial, SlotKind::Local),
        )
        .await
        .is_none()
        {
            crate::tunnels::finish_dial(app, LOCAL_SLOT, dial.serial, Err(cancelled()));

            return Err(cancelled());
        }

        respawn(app, state, dial.serial, cancel).await
    }

    /// The primary's dial. A dial a newer one superseded (a restart, an
    /// interactive request) never fails its caller — failing would release the
    /// hold and tear down the successor. It waits for the successor instead and
    /// hands back the child that dial installed. A removal, a quit, or a key a
    /// lease has since re-created for itself fails it.
    pub async fn run_dial_or_join(
        app: &AppHandle,
        state: &LocalBackendState,
        dial: Dial,
    ) -> Result<LocalBackend, String> {
        let (key, serial) = (dial.key.clone(), dial.serial);

        let error = match run_dial(app, state, dial).await {
            Ok(backend) => return Ok(backend),
            Err(error) => error,
        };

        // The same verdict the SSH tail takes. `LOCAL_INSTANCE_KEY` is one
        // constant fingerprint, so Quiet is unreachable here and the verdict
        // turns on who the key belongs to: a newer PRIMARY attempt's child is
        // adopted instead of failing into a stop that would remove that slot and
        // cancel its dial, while a key a LEASE re-created is that lease's — this
        // caller fails, holding nothing, and the slot goes when the lease does.
        let crate::tunnels::Joined::Successor(successor) =
            crate::tunnels::join_dial(app, &key, serial, LOCAL_INSTANCE_KEY)
        else {
            return Err(error.message);
        };

        crate::tunnels::wait(successor)
            .await
            .map_err(|e| e.message)?;

        current(state)
            .await
            .ok_or_else(|| "the local backend stopped before it could be adopted".to_string())
    }

    /// Start a child for dial `serial` and promote it if the slot still waits on
    /// that dial; report the outcome to the tunnel book either way.
    async fn respawn(
        app: &AppHandle,
        state: &LocalBackendState,
        serial: u64,
        cancel: CancellationToken,
    ) -> Result<LocalBackend, TunnelError> {
        use crate::tunnels::{finish_dial, install_lock, is_current};

        let transport = app.state::<crate::transport::TransportState>();
        let forget = |base: &str| transport.forget_tunnel_auth(base);
        let token = random_token();
        let program = std::env::var("HERMES_BIN").unwrap_or_else(|_| "hermes".to_string());

        let spawned = {
            let _guard = install_lock(app, LOCAL_SLOT).await;

            spawn_recorded(
                &state.running,
                serial,
                || is_current(app, LOCAL_SLOT, serial),
                &cancel,
                &forget,
                || command(&program, &token).spawn(),
                &state.log,
            )
            .await
        };

        let ready = match spawned {
            Ok(ready) => ready,
            Err(refusal) => {
                let error = match refusal {
                    SpawnRefusal::Failed(e) => TunnelError::new(
                        FailureKind::HermesNotFound,
                        format!(
                            "could not start `{program}`: {e}. Is the Hermes CLI installed / on PATH?"
                        ),
                    ),
                    SpawnRefusal::Cancelled => cancelled(),
                    SpawnRefusal::Closed => {
                        TunnelError::new(FailureKind::Unavailable, "the app is quitting")
                    }
                    SpawnRefusal::NotCurrent => superseded(),
                };

                finish_dial(app, LOCAL_SLOT, serial, Err(error.clone()));

                return Err(error);
            }
        };

        let result = await_ready(&cancel, ready, &token).await;

        let _guard = install_lock(app, LOCAL_SLOT).await;
        let mut local = state.running.lock().await;

        let error = match result {
            Ok(backend) => {
                let spawn = state
                    .serial
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                let promoted = promote(
                    &mut local,
                    serial,
                    || is_current(app, LOCAL_SLOT, serial),
                    spawn,
                    backend.clone(),
                    |backend| {
                        transport.set_tunnel_auth(
                            &backend.base_url,
                            crate::transport::ConnectionAuth {
                                connection_id: crate::connections::registry::LOCAL_CONNECTION_ID
                                    .to_string(),
                                token: Some(backend.token.clone()),
                                headers: Vec::new(),
                            },
                        )
                    },
                );

                if promoted {
                    drop(local);
                    watch_child(app.clone(), spawn);
                    finish_dial(app, LOCAL_SLOT, serial, Ok(backend.base_url.clone()));

                    return Ok(backend);
                }

                superseded()
            }
            Err((FailureKind::Transient, message)) => {
                TunnelError::new(FailureKind::Transient, state.log.with_tail(message))
            }
            Err((kind, message)) => TunnelError::new(kind, message),
        };

        let _ = end_own_start(&mut local, serial);
        drop(local);
        finish_dial(app, LOCAL_SLOT, serial, Err(error.clone()));

        Err(error)
    }

    /// What the watcher of child `spawn` finds.
    #[derive(Debug, PartialEq, Eq)]
    pub enum Verdict {
        Alive,
        /// It exited on its own.
        Died,
        /// A newer child is running; that child's own watcher reports it.
        Replaced,
        /// No running child at all. Every legitimate kill leaves the slot absent,
        /// Connecting under the next spawn, or quitting, where `on_dead` does
        /// nothing; anything else is a Ready slot whose child vanished.
        Gone,
    }

    pub fn watch_verdict(local: &mut Local, spawn: u64) -> Verdict {
        match &mut local.entry {
            Some(Entry::Running {
                spawn: watched,
                child,
                ..
            }) if *watched == spawn => match child.try_wait() {
                Ok(None) => Verdict::Alive,
                _ => Verdict::Died,
            },
            Some(Entry::Running { .. }) => Verdict::Replaced,
            _ => Verdict::Gone,
        }
    }

    /// Notice the running child going away and tell the tunnel book.
    fn watch_child(app: AppHandle, spawn: u64) {
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(CHILD_WATCH_INTERVAL).await;

                let state = app.state::<LocalBackendState>();
                let mut local = state.running.lock().await;

                match watch_verdict(&mut local, spawn) {
                    Verdict::Alive => continue,
                    Verdict::Replaced => return,
                    Verdict::Gone => {
                        drop(local);
                        log::warn!(
                            "{}",
                            state.log.with_tail(
                                "[tunnel] the local backend is gone without having been stopped"
                            )
                        );
                    }
                    Verdict::Died => {
                        if let Some(Entry::Running { backend, .. }) = local.entry.take() {
                            app.state::<crate::transport::TransportState>()
                                .forget_tunnel_auth(&backend.base_url);
                        }

                        drop(local);
                        log::warn!(
                            "{}",
                            state
                                .log
                                .with_tail("[tunnel] the local backend exited on its own")
                        );
                    }
                }

                crate::tunnels::on_dead(&app, LOCAL_SLOT);

                return;
            }
        });
    }

    /// Whether the running child is still running.
    pub async fn alive(state: &LocalBackendState) -> bool {
        state
            .running
            .lock()
            .await
            .running()
            .is_some_and(|(child, _)| matches!(child.try_wait(), Ok(None)))
    }

    pub async fn current(state: &LocalBackendState) -> Option<LocalBackend> {
        state
            .running
            .lock()
            .await
            .running()
            .map(|(_, backend)| backend.clone())
    }

    /// Kill the child, starting or running, and return its drains. `close`:
    /// quit — nothing spawns after this.
    pub async fn kill(app: &AppHandle, state: &LocalBackendState, close: bool) -> Vec<Drain> {
        let transport = app.state::<crate::transport::TransportState>();
        let mut local = state.running.lock().await;

        kill_entry(&mut local, close, &|base| {
            transport.forget_tunnel_auth(base)
        })
    }

    pub async fn status(state: &LocalBackendState) -> LocalBackendStatus {
        match state.running.lock().await.running() {
            Some((_, backend)) => LocalBackendStatus {
                running: true,
                base_url: Some(backend.base_url.clone()),
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
/// to reach it. A hard stop: every lease on the child ends with it, and a start
/// in progress is killed too.
#[cfg(desktop)]
pub async fn stop(app: &AppHandle) {
    crate::tunnels::stop_slot(app, LOCAL_SLOT, SlotKind::Local).await;
}

/// The tunnel book's teardown and exit door: kills the child, starting or
/// running. `close` is quit's — no spawn after it. Returns the killed child's
/// pipe drains, for quit to wait on. No-op on mobile.
#[cfg(desktop)]
pub(crate) async fn kill_child(app: &AppHandle, close: bool) -> Vec<tokio::task::JoinHandle<()>> {
    match app.try_state::<imp::LocalBackendState>() {
        Some(state) => imp::kill(app, &state, close).await,
        None => Vec::new(),
    }
}

#[cfg(mobile)]
pub(crate) async fn kill_child(
    _app: &tauri::AppHandle,
    _close: bool,
) -> Vec<tokio::task::JoinHandle<()>> {
    Vec::new()
}

/// Quit: flush the child's log, waiting for its writer until `until` at most.
#[cfg(desktop)]
pub(crate) fn close_log(app: &AppHandle, until: tokio::time::Instant) {
    if let Some(state) = app.try_state::<imp::LocalBackendState>() {
        state
            .log
            .close_and_join(until.saturating_duration_since(tokio::time::Instant::now()));

        let dropped = state.log.dropped();

        if dropped > 0 {
            log::warn!(
                "[tunnel] the local backend log dropped {dropped} lines it could not keep up with"
            );
        }
    }
}

#[cfg(mobile)]
pub(crate) fn close_log(_app: &tauri::AppHandle, _until: tokio::time::Instant) {}

/// Start the child for a background lease (MJXHRM-592).
#[cfg(desktop)]
pub(crate) async fn dial_tunnel(app: &AppHandle, dial: Dial) {
    let state = app.state::<imp::LocalBackendState>();
    let _ = imp::run_dial(app, &state, dial).await;
}

#[cfg(mobile)]
pub(crate) async fn dial_tunnel(app: &tauri::AppHandle, dial: crate::tunnels::Dial) {
    crate::tunnels::finish_dial(
        app,
        crate::tunnels::LOCAL_SLOT,
        dial.serial,
        Err(crate::tunnels::TunnelError::new(
            crate::tunnels::FailureKind::UnsupportedPlatform,
            "unsupported_platform",
        )),
    );
}

/// The active connection's local backend.
///
/// A child that is already running is ADOPTED: it is the unified server and
/// serves every profile, and a background lease may be riding it. `profile` is
/// the one preselected in the UI; only `local_backend_restart` respawns a live
/// child.
#[cfg(desktop)]
#[tauri::command]
pub async fn local_backend_spawn(
    app: AppHandle,
    state: tauri::State<'_, imp::LocalBackendState>,
    profile: Option<String>,
) -> Result<LocalBackend, String> {
    let _ = profile;
    let alive = imp::alive(&state).await;
    let spec = SlotSpec {
        connection_id: crate::connections::registry::LOCAL_CONNECTION_ID.to_string(),
        kind: SlotKind::Local,
        instance_key: LOCAL_INSTANCE_KEY.to_string(),
        fingerprint: LOCAL_INSTANCE_KEY.to_string(),
    };

    match crate::tunnels::hold_primary(&app, LOCAL_SLOT, spec, alive, false, "local-primary")
        .map_err(|e| e.message)?
    {
        Hold::Reuse(_) => {}
        Hold::Join(_, rx) => {
            crate::tunnels::wait(rx).await.map_err(|e| e.message)?;
        }
        Hold::Dial(dial) => return imp::run_dial_or_join(&app, &state, dial).await,
    }

    imp::current(&state)
        .await
        .ok_or_else(|| "the local backend stopped before it could be adopted".to_string())
}

/// "Restart backend": respawn the child in place. Every lease stays held and
/// reconnects on `tunnel://local/changed`. A restart during a start cancels
/// that start and begins at once.
#[cfg(desktop)]
#[tauri::command]
pub async fn local_backend_restart(
    app: AppHandle,
    state: tauri::State<'_, imp::LocalBackendState>,
) -> Result<LocalBackend, String> {
    let Some(dial) = crate::tunnels::begin_restart(&app, LOCAL_SLOT, "local-restart") else {
        return local_backend_spawn(app, state, None).await;
    };

    imp::run_dial_or_join(&app, &state, dial).await
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
pub async fn local_backend_stop(app: AppHandle) -> Result<(), String> {
    // No slot: the child still goes, through the teardown's install lock and its
    // re-created-slot skip, so a lease's start that raced in is never killed.
    if !crate::tunnels::release_primary(&app, LOCAL_SLOT).await {
        crate::tunnels::teardown(&app, LOCAL_SLOT, SlotKind::Local).await;
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
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    use tokio::process::{Child, Command};
    use tokio::sync::Mutex;
    use tokio_util::sync::CancellationToken;

    use super::imp::{
        await_ready, end_own_start, kill_entry, parse_ready_port, promote, spawn_recorded,
        watch_verdict, Drain, Entry, Local, SpawnRefusal, Verdict,
    };
    use super::LocalBackend;
    use crate::backend_log::BackendLog;

    /// Only a hang guard: every wait below ends on an event, never on time.
    const HANG_GUARD: Duration = Duration::from_secs(20);

    fn program(program: &str, args: &[&str]) -> std::io::Result<Child> {
        Command::new(program)
            .args(args)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
    }

    fn log() -> Arc<BackendLog> {
        Arc::new(BackendLog::new(None))
    }

    async fn start(
        state: &Mutex<Local>,
        dial: u64,
        cancel: &CancellationToken,
    ) -> Result<tokio::sync::oneshot::Receiver<u16>, SpawnRefusal> {
        spawn_recorded(
            state,
            dial,
            || true,
            cancel,
            &|_| {},
            || program("sleep", &["60"]),
            &log(),
        )
        .await
    }

    async fn ended(drains: Vec<Drain>) {
        tokio::time::timeout(HANG_GUARD, async {
            for drain in drains {
                let _ = drain.await;
            }
        })
        .await
        .expect("the drains end at pipe EOF");
    }

    fn starting_dial(local: &Local) -> Option<u64> {
        match &local.entry {
            Some(Entry::Starting { dial, .. }) => Some(*dial),
            _ => None,
        }
    }

    fn backend() -> LocalBackend {
        LocalBackend {
            base_url: "http://127.0.0.1:41000".to_string(),
            token: "t".to_string(),
            ws_url: "ws://127.0.0.1:41000/api/ws?token=t".to_string(),
        }
    }

    #[test]
    fn the_local_backend_launches_as_the_unified_default_server() {
        assert_eq!(
            super::imp::launch_args().join(" "),
            "--profile default serve --host 127.0.0.1 --port 0"
        );
    }

    #[test]
    fn the_child_knows_its_parent_for_the_crash_backstop() {
        let env = super::imp::launch_env("t");

        assert!(env.contains(&(
            "HERMES_PARENT_PID".to_string(),
            std::process::id().to_string()
        )));
    }

    /// A backend that writes a megabyte to stderr before it is ready must still
    /// be seen as ready: nobody reading stderr blocks it on a full pipe.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_chatty_backend_still_announces_its_port() {
        let state = Mutex::new(Local::default());
        let ready = spawn_recorded(
            &state,
            1,
            || true,
            &CancellationToken::new(),
            &|_| {},
            || {
                program(
                    "sh",
                    &["-c", "yes 'some backend noise on stderr' | head -c 1048576 >&2; echo HERMES_BACKEND_READY port=4321"],
                )
            },
            &log(),
        )
        .await
        .expect("spawned");

        let port = tokio::time::timeout(HANG_GUARD, ready)
            .await
            .expect("the ready line arrives while stderr is drained");

        assert_eq!(port, Ok(4321));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn nothing_spawns_once_quit_closed_the_state() {
        let state = Mutex::new(Local::default());
        let spawned = AtomicBool::new(false);

        kill_entry(&mut *state.lock().await, true, &|_| {});

        let refused = spawn_recorded(
            &state,
            1,
            || true,
            &CancellationToken::new(),
            &|_| {},
            || {
                spawned.store(true, Ordering::SeqCst);
                program("sleep", &["60"])
            },
            &log(),
        )
        .await;

        assert_eq!(refused.err(), Some(SpawnRefusal::Closed));
        assert!(!spawned.load(Ordering::SeqCst), "the spawn never ran");
        assert!(state.lock().await.entry.is_none());

        // Nor for a dial the slot no longer waits on.
        let state = Mutex::new(Local::default());
        let refused = spawn_recorded(
            &state,
            1,
            || false,
            &CancellationToken::new(),
            &|_| {},
            || {
                spawned.store(true, Ordering::SeqCst);
                program("sleep", &["60"])
            },
            &log(),
        )
        .await;

        assert_eq!(refused.err(), Some(SpawnRefusal::NotCurrent));
        assert!(!spawned.load(Ordering::SeqCst), "the spawn never ran");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn quit_kills_a_child_that_is_still_starting() {
        let state = Mutex::new(Local::default());

        start(&state, 1, &CancellationToken::new())
            .await
            .expect("spawned");

        let drains = kill_entry(&mut *state.lock().await, true, &|_| {});

        assert_eq!(drains.len(), 2, "a starting child's drains are handed over");
        ended(drains).await;

        let local = state.lock().await;

        assert!(local.entry.is_none());
        assert!(local.closed);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_cancelled_start_stops_waiting_and_ends_its_own_child() {
        let state = Mutex::new(Local::default());
        let cancel = CancellationToken::new();
        // `sleep` never announces a port.
        let ready = start(&state, 1, &cancel).await.expect("spawned");

        cancel.cancel();

        let result = tokio::time::timeout(HANG_GUARD, await_ready(&cancel, ready, "t"))
            .await
            .expect("a cancelled start does not wait for readiness");

        assert_eq!(
            result.map(|_| ()).map_err(|(kind, _)| kind),
            Err(crate::tunnels::FailureKind::Cancelled)
        );

        let drains = end_own_start(&mut *state.lock().await, 1).expect("its own start");

        ended(drains).await;
        assert!(state.lock().await.entry.is_none());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_start_ends_only_its_own_child() {
        let state = Mutex::new(Local::default());
        let cancel = CancellationToken::new();

        start(&state, 1, &cancel).await.expect("spawned");
        // A newer dial's spawn kills the first start and records its own.
        start(&state, 2, &cancel).await.expect("spawned");

        let mut local = state.lock().await;

        assert!(end_own_start(&mut local, 1).is_none());
        assert_eq!(starting_dial(&local), Some(2));

        ended(kill_entry(&mut local, true, &|_| {})).await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn only_the_dials_own_start_is_promoted_and_only_then_is_auth_set() {
        let state = Mutex::new(Local::default());
        let cancel = CancellationToken::new();
        let auth_set = AtomicBool::new(false);

        // Killed before it was ready.
        start(&state, 1, &cancel).await.expect("spawned");
        ended(kill_entry(&mut *state.lock().await, false, &|_| {})).await;

        assert!(!promote(
            &mut *state.lock().await,
            1,
            || true,
            1,
            backend(),
            |_| auth_set.store(true, Ordering::SeqCst)
        ));

        // Replaced by a newer start.
        start(&state, 2, &cancel).await.expect("spawned");

        let mut local = state.lock().await;

        assert!(!promote(
            &mut local,
            1,
            || true,
            1,
            backend(),
            |_| auth_set.store(true, Ordering::SeqCst)
        ));
        assert_eq!(starting_dial(&local), Some(2));

        // The slot stopped waiting on the dial.
        assert!(!promote(
            &mut local,
            2,
            || false,
            1,
            backend(),
            |_| auth_set.store(true, Ordering::SeqCst)
        ));
        assert!(
            !auth_set.load(Ordering::SeqCst),
            "no credential for a start that was not promoted"
        );

        assert!(promote(
            &mut local,
            2,
            || true,
            1,
            backend(),
            |_| auth_set.store(true, Ordering::SeqCst)
        ));
        assert!(auth_set.load(Ordering::SeqCst));
        assert!(matches!(local.entry, Some(Entry::Running { .. })));

        let forgotten = std::sync::Mutex::new(Vec::new());

        ended(kill_entry(&mut local, true, &|base| {
            forgotten.lock().unwrap().push(base.to_string())
        }))
        .await;
        assert_eq!(*forgotten.lock().unwrap(), vec!["http://127.0.0.1:41000"]);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_cancel_that_lands_while_the_spawn_waits_for_the_lock_is_seen() {
        let state = Mutex::new(Local::default());
        let cancel = CancellationToken::new();
        let spawned = AtomicBool::new(false);
        let log = log();
        let held = state.lock().await;
        let spawning = spawn_recorded(
            &state,
            1,
            || true,
            &cancel,
            &|_| {},
            || {
                spawned.store(true, Ordering::SeqCst);
                program("sleep", &["60"])
            },
            &log,
        );

        tokio::pin!(spawning);

        assert!(
            tokio::time::timeout(Duration::ZERO, &mut spawning)
                .await
                .is_err(),
            "the spawn waits for the lock"
        );

        cancel.cancel();
        drop(held);

        assert_eq!(spawning.await.err(), Some(SpawnRefusal::Cancelled));
        assert!(!spawned.load(Ordering::SeqCst));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_replaced_running_child_is_forgotten_before_the_next_spawn() {
        let state = Mutex::new(Local::default());
        let cancel = CancellationToken::new();
        let events = std::sync::Mutex::new(Vec::<String>::new());

        start(&state, 1, &cancel).await.expect("spawned");
        assert!(promote(
            &mut *state.lock().await,
            1,
            || true,
            1,
            backend(),
            |_| {}
        ));

        spawn_recorded(
            &state,
            2,
            || true,
            &cancel,
            &|base| events.lock().unwrap().push(format!("forget:{base}")),
            || {
                events.lock().unwrap().push("spawn".to_string());
                program("sleep", &["60"])
            },
            &log(),
        )
        .await
        .expect("spawned");

        assert_eq!(
            *events.lock().unwrap(),
            vec![
                format!("forget:{}", backend().base_url),
                "spawn".to_string()
            ]
        );

        ended(kill_entry(&mut *state.lock().await, true, &|_| {})).await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_watcher_tells_a_death_from_a_replacement_and_a_vanished_child() {
        let state = Mutex::new(Local::default());
        let cancel = CancellationToken::new();
        let mut local = state.lock().await;

        assert_eq!(watch_verdict(&mut local, 1), Verdict::Gone, "no child");
        drop(local);

        start(&state, 1, &cancel).await.expect("spawned");

        let mut local = state.lock().await;

        assert_eq!(watch_verdict(&mut local, 1), Verdict::Gone, "only starting");
        assert!(promote(&mut local, 1, || true, 7, backend(), |_| {}));
        assert_eq!(watch_verdict(&mut local, 7), Verdict::Alive);
        assert_eq!(watch_verdict(&mut local, 6), Verdict::Replaced);

        if let Some(Entry::Running { child, .. }) = &mut local.entry {
            let _ = child.start_kill();
            let _ = tokio::time::timeout(HANG_GUARD, child.wait()).await;
        }

        assert_eq!(watch_verdict(&mut local, 7), Verdict::Died);

        ended(kill_entry(&mut local, true, &|_| {})).await;
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
