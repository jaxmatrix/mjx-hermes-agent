//! SSH gateway transport (MJX-55).
//!
//! Reaches a Hermes backend on a remote host over SSH. The shape, ported from the
//! Electron desktop app (`apps/desktop/electron/{ssh-connection,remote-lifecycle,
//! windows-remote-lifecycle}.ts`):
//!
//!   1. Dial the host as an SSH *client*. Nothing listens on port 22 here — 22 is
//!      the destination, and the gateway protocol is never piped over stdio.
//!   2. Run control-plane `exec` channels to probe the platform, locate `hermes`,
//!      check its capabilities, read/write a lockfile, and upload a session token
//!      over stdin (never argv).
//!   3. Spawn `hermes serve --isolated --host 127.0.0.1 --port 0` detached on the
//!      remote and scrape `HERMES_(BACKEND|DASHBOARD)_READY port=<N>` from its log.
//!      It binds remote loopback only — the tunnel is the sole route in.
//!   4. Forward a local `127.0.0.1:<ephemeral>` TCP port to that remote port. The
//!      ordinary HTTP + `/api/ws` traffic then rides that forward, so the rest of
//!      the app just sees a token-authed backend on loopback.
//!   5. On reconnect, reuse the still-running remote backend via the lockfile plus
//!      an authenticated `GET /api/ssh/ownership` nonce proof. Teardown drops the
//!      tunnel, NOT the remote backend.
//!
//! Unlike `local_backend.rs`, nothing in this module is `#[cfg(desktop)]`-gated.
//! russh is pure Rust and cross-compiles to the mobile targets, which is the whole
//! reason we do not shell out to the system `ssh` binary — see the `russh`
//! dependency comment in Cargo.toml.
//!
//! The POSIX path (steps 1-5) is live. `windows_lifecycle` — the same lifecycle
//! against a remote host running Windows — is still pure-only and is wired next.

// windows_lifecycle has no caller until its dispatch lands, and a handful of
// accessors exist for it. Without this they read as dead code and the real
// warnings drown.
#![allow(dead_code)]

pub mod auth;
pub mod clock;
pub mod config;
pub mod error;
pub mod forward;
pub mod install;
pub mod known_hosts;
pub mod ownership;
pub mod posix_lifecycle;
pub mod progress;
pub mod prompt;
pub mod remote_paths;
pub mod remote_scripts;
pub mod reuse;
pub mod session;
pub mod target;
pub mod windows_lifecycle;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use tokio::sync::{mpsc, oneshot, Mutex};

use auth::Credentials;
use error::{SshError, SshErrorKind};
use known_hosts::{HostKeyPolicy, HostKeyPrompt};
use progress::{ProgressReporter, SshStep};
use prompt::{ChannelPrompter, NoPrompter, PromptKind, PromptRequest, Prompter};
use session::{ConnectOptions, SshSession, DEFAULT_CONNECT_TIMEOUT};
use target::{normalize_ssh_target, SshTargetInput};

/// What the frontend sends to open or test a connection.
#[derive(Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct SshConnectConfig {
    #[serde(flatten)]
    pub target: SshTargetInput,
    /// Which gateway profile this connection is for. Also the ownership scope,
    /// so two profiles never share one remote backend.
    #[serde(default)]
    pub profile: Option<String>,
    /// A PEM held in the OS keyring. The mobile route — there is no usable
    /// private-key file picker on Android or iOS.
    #[serde(default)]
    pub private_key_pem: Option<String>,
    #[serde(default)]
    pub passphrase: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
    /// Whether the caller can answer prompts. False for a boot restore, which
    /// runs before any UI is mounted.
    #[serde(default)]
    pub interactive: bool,
    /// This install's stable 32-hex id, held in the OS keyring by the frontend.
    ///
    /// Universal has no equivalent of desktop's installation-ID file, so the
    /// value is supplied rather than derived. It must be stable across launches:
    /// losing it orphans remote backends, because the next connect will not
    /// recognize the lockfile and so will neither reuse nor clean up.
    #[serde(default)]
    pub installation_id: Option<String>,
    /// The session token from the last successful connect, if we still hold one.
    /// Without it a running backend cannot be reattached to, only replaced.
    #[serde(default)]
    pub reuse_token: Option<String>,
    /// Which REGISTERED connection this dial belongs to (MJXHRM-446).
    ///
    /// Absent for the connection that inherited the pre-registry world, and that
    /// absence is what collapses the scope — see `registry_scope_of`. Two ssh
    /// sources on one profile name therefore keep two independent sessions,
    /// forwards and remote backends instead of evicting each other.
    #[serde(default)]
    pub connection_id: Option<String>,
}

/// A live SSH-backed gateway connection, as the frontend sees it.
///
/// Shaped like `local_backend.rs`'s `LocalBackend` and extended, because from
/// the app's point of view this *is* a token-authed backend on loopback — the
/// SSH part is an implementation detail of how it got there.
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SshConnection {
    /// Always `http://127.0.0.1:<ephemeral>`. Changes on every re-tunnel, so
    /// nothing durable may be keyed on it — use `ownership_id` instead.
    pub base_url: String,
    pub token: String,
    pub ws_url: String,
    pub local_port: u16,
    pub remote_port: u16,
    pub pid: i64,
    /// True when we reattached to a backend that was already running.
    pub reused: bool,
    pub remote_platform: String,
    pub remote_arch: String,
    pub hermes_path: String,
    pub hermes_version: String,
    /// Stable across re-tunnels. The right cache key, and what the statusbar
    /// pill and the file tree should identify a connection by.
    pub ownership_id: String,
    /// `user@host`, for display. The loopback base URL says nothing useful.
    pub host_label: String,
    /// The scope the session, forward and `ssh://{scope}/disconnected` event
    /// live under — one per connection, whatever the profile (MJXHRM-592).
    pub scope: String,
}

/// The result of a reachability check.
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SshTestResult {
    pub reachable: bool,
    pub host_label: String,
    /// `uname -s` from the remote, when we got that far.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub platform: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub arch: Option<String>,
}

/// What `ssh_resolve_host` reports back, so the settings form can show what
/// `~/.ssh/config` actually resolved to rather than leaving the user guessing.
#[derive(Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct SshResolvedHost {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hostname: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub identity_file: Option<String>,
    /// Directives we parsed but do not act on. Surfaced rather than swallowed:
    /// silently ignoring a ProxyJump would connect somewhere the user did not
    /// ask for.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub unsupported: Vec<String>,
}

/// A connect attempt in flight, and the channels its prompts arrive on.
pub(crate) struct Attempt {
    cancel: tokio_util::sync::CancellationToken,
    /// Pending questions, keyed by prompt id, awaiting `ssh_answer_prompt`.
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<String>>>>,
    /// Pending host-key decisions, awaiting `ssh_trust_host_key`.
    pending_host_key: Arc<Mutex<Option<oneshot::Sender<bool>>>>,
}

/// Live sessions and in-flight attempts, held in Tauri managed state.
///
/// This is what replaces desktop's on-disk control socket. Nothing about a
/// session outlives the process, so there is no stale-master problem to detect
/// or evict.
#[derive(Default)]
pub struct SshState {
    sessions: Mutex<HashMap<String, Arc<SshSession>>>,
    /// Live tunnels, kept alive by being held here: dropping a PortForward
    /// stops its accept loop.
    forwards: Mutex<HashMap<String, forward::PortForward>>,
    /// What each scope's live tunnel handed back, so a second dial of a scope
    /// that is already up adopts it instead of replacing it (MJXHRM-592).
    connections: Mutex<HashMap<String, SshConnection>>,
    attempts: Mutex<HashMap<String, Arc<Attempt>>>,
}

impl SshState {
    /// The live session for a scope, if there is one.
    ///
    /// Exposed for the in-app browser's forward lease (MJXHRM-447), which opens
    /// a SECOND forward ABOVE `SshState.forwards` rather than re-keying it:
    /// that map holds exactly one forward per scope — the gateway's own — and a
    /// dev-server tunnel must not evict it.
    pub(crate) async fn session_for_scope(&self, scope: &str) -> Option<Arc<SshSession>> {
        self.sessions.lock().await.get(scope).map(Arc::clone)
    }
}

/// The scope key for a connection — live sessions, forwards AND, through
/// `ownership::ssh_ownership_id`, the identity written into the remote lockfile.
///
/// Before the registry (MJXHRM-446) this was the profile alone, so two ssh
/// SOURCES on the same profile name evicted each other's session, shared one
/// watcher slot and — worst — shared one remote backend.
///
/// The `None` arm is BYTE-IDENTICAL to what that did, and that is the single
/// most load-bearing compatibility property in the registry: the connection that
/// inherited the pre-registry world dials with no id, so its ownership id still
/// hashes the bare profile, the lockfile still matches, and an upgrade
/// REATTACHES to the running remote backend instead of orphaning it. Connections
/// 2..N get `conn:<id>::<profile>`, which has never been hashed before, so their
/// first connect is a clean spawn — correct, because they *are* new backends.
/// Colons are invalid in profile names, so the two spaces cannot collide.
pub fn registry_scope_of(connection_id: Option<&str>, profile: Option<&str>) -> String {
    match connection_id.map(str::trim).filter(|id| !id.is_empty()) {
        None => profile.unwrap_or("").to_string(),
        // The composite grammar is shared with the frontend's `backendScopeKey`
        // so a forward lease (MJXHRM-447) and this session key are one string.
        Some(id) => crate::connections::registry_backend_scope_key(Some(id), profile),
    }
}

/// The user's home directory, if there is one. Mobile has none, and every caller
/// treats that as "no `~/.ssh` to read" rather than as an error.
fn home_dir() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        std::env::var("USERPROFILE").ok().map(PathBuf::from)
    }

    #[cfg(not(target_os = "windows"))]
    {
        // Android reports a HOME, but it is an app-private sandbox with no
        // ~/.ssh in it. Treating it as absent keeps the mobile path honest.
        if cfg!(target_os = "android") || cfg!(target_os = "ios") {
            return None;
        }

        std::env::var("HOME").ok().map(PathBuf::from)
    }
}

/// Where to record trusted host keys.
fn known_hosts_path(app: &AppHandle) -> Result<PathBuf, SshError> {
    let app_data = app.path().app_data_dir().ok();

    known_hosts::store_path(home_dir().as_deref(), app_data.as_deref()).ok_or_else(|| {
        SshError::new(
            SshErrorKind::Unknown,
            "No writable location for the known-hosts store.",
        )
    })
}

/// Resolve the settings-form target against `~/.ssh/config`, then decide the
/// user to log in as.
///
/// Precedence matches OpenSSH: an explicit value beats the config file, which
/// beats the local username.
fn resolve_target(
    input: &SshTargetInput,
) -> Result<(target::SshTarget, String, Credentials), SshError> {
    let Some(mut target) = normalize_ssh_target(input)? else {
        return Err(SshError::new(
            SshErrorKind::Unknown,
            "An SSH host is required.",
        ));
    };

    let home = home_dir();
    let resolved = config::default_config_path(home.as_deref())
        .map(|path| {
            config::resolve_host(
                &target.host,
                &path,
                home.as_deref(),
                &config::FsConfigReader,
            )
        })
        .unwrap_or_default();

    // Refuse rather than quietly connect direct: a Host the user expects to be
    // reachable only through a bastion would otherwise resolve to a different
    // machine entirely.
    if resolved.requires_unsupported_proxy() {
        return Err(SshError::new(
            SshErrorKind::UnsupportedPlatform,
            format!(
                "{} is configured with ProxyJump/ProxyCommand in ~/.ssh/config, which is not supported yet. \
                 Connect to the jump host's target directly, or remove the directive.",
                target.host
            ),
        ));
    }

    if let Some(hostname) = resolved.hostname.clone() {
        target.host = hostname;
    }

    if target.port.is_none() {
        target.port = resolved.port;
    }

    let user = target
        .user
        .clone()
        .or_else(|| resolved.user.clone())
        .or_else(|| std::env::var("USER").ok())
        .or_else(|| std::env::var("USERNAME").ok())
        .unwrap_or_else(|| "root".to_string());

    let credentials = Credentials {
        key_path: target.key_path.clone(),
        identity_file: resolved.identity_file.clone(),
        ..Default::default()
    };

    Ok((target, user, credentials))
}

/// Register an attempt under `cancel` — the dial's own token, created by the
/// tunnel book — so `ssh_cancel` reaches it through every step before the
/// session opens: the supersede drain, the credential read, the unlock gate.
///
/// A superseding dial cancels its predecessor's token in the book, not here. A
/// predecessor that registers late arrives already cancelled and does not take
/// the id, so it can never displace (or cancel) the newer attempt sharing it.
pub(crate) async fn begin_attempt(
    state: &SshState,
    attempt_id: &str,
    cancel: tokio_util::sync::CancellationToken,
) -> Arc<Attempt> {
    let attempt = Arc::new(Attempt {
        cancel,
        pending: Arc::new(Mutex::new(HashMap::new())),
        pending_host_key: Arc::new(Mutex::new(None)),
    });

    let mut attempts = state.attempts.lock().await;

    // Checked holding the lock: a supersede that lands while this waits for it
    // is still seen, so a cancelled attempt never displaces a newer one.
    if !attempt.cancel.is_cancelled() {
        attempts.insert(attempt_id.to_string(), Arc::clone(&attempt));
    }

    drop(attempts);

    attempt
}

/// Forget an attempt once its dial is over — only this one, never a newer
/// attempt that took the id.
async fn end_attempt(state: &SshState, attempt_id: &str, attempt: &Arc<Attempt>) {
    let mut attempts = state.attempts.lock().await;

    if attempts
        .get(attempt_id)
        .is_some_and(|held| Arc::ptr_eq(held, attempt))
    {
        attempts.remove(attempt_id);
    }
}

/// Cancel the attempt registered under `attempt_id` (`ssh_cancel`).
async fn cancel_in(state: &SshState, attempt_id: &str) {
    let attempt = state.attempts.lock().await.remove(attempt_id);

    if let Some(attempt) = attempt {
        attempt.cancel.cancel();
    }
}

/// Build the prompt plumbing for a registered attempt, so `ssh_answer_prompt`
/// and `ssh_trust_host_key` can route answers back.
fn arm_prompts(
    app: &AppHandle,
    attempt_id: &str,
    attempt: &Arc<Attempt>,
    interactive: bool,
) -> (Box<dyn Prompter>, Arc<HostKeyPolicy>) {
    let attempt = Arc::clone(attempt);

    if !interactive {
        // A boot restore has no UI to answer with. Trust-on-first-use still
        // applies (that is what desktop did), but nothing may block on a person.
        return (Box::new(NoPrompter), Arc::new(HostKeyPolicy::AcceptNew));
    }

    let (prompt_tx, prompt_rx) = mpsc::channel::<PromptRequest>(4);
    let (host_key_tx, host_key_rx) = mpsc::channel::<HostKeyPrompt>(1);

    tokio::spawn(forward_prompts(
        app.clone(),
        attempt_id.to_string(),
        Arc::clone(&attempt),
        prompt_rx,
    ));
    tokio::spawn(forward_host_key_prompts(
        app.clone(),
        attempt_id.to_string(),
        Arc::clone(&attempt),
        host_key_rx,
    ));

    (
        Box::new(ChannelPrompter::new(prompt_tx)),
        Arc::new(HostKeyPolicy::Ask(host_key_tx)),
    )
}

/// What the UI receives when the connect needs an answer.
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
struct PromptEvent {
    prompt_id: String,
    kind: PromptKind,
    label: String,
    secret: bool,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
struct HostKeyEvent {
    host: String,
    port: u16,
    fingerprint: String,
}

/// Relay credential prompts to the UI and park the responder.
async fn forward_prompts(
    app: AppHandle,
    attempt_id: String,
    attempt: Arc<Attempt>,
    mut rx: mpsc::Receiver<PromptRequest>,
) {
    use tauri::Emitter;

    let mut counter: u64 = 0;

    while let Some(request) = rx.recv().await {
        counter += 1;
        let prompt_id = format!("{attempt_id}-{counter}");

        attempt
            .pending
            .lock()
            .await
            .insert(prompt_id.clone(), request.respond);

        let payload = PromptEvent {
            prompt_id,
            kind: request.kind,
            label: request.label,
            secret: request.secret,
        };

        // A failed emit leaves the responder parked; the prompt's own timeout
        // then releases it rather than hanging the attempt forever.
        let _ = app.emit(&format!("ssh://{attempt_id}/prompt"), payload);
    }
}

/// Relay host-key trust questions to the UI.
async fn forward_host_key_prompts(
    app: AppHandle,
    attempt_id: String,
    attempt: Arc<Attempt>,
    mut rx: mpsc::Receiver<HostKeyPrompt>,
) {
    use tauri::Emitter;

    while let Some(request) = rx.recv().await {
        *attempt.pending_host_key.lock().await = Some(request.respond);

        let payload = HostKeyEvent {
            host: request.host,
            port: request.port,
            fingerprint: request.fingerprint,
        };

        let _ = app.emit(&format!("ssh://{attempt_id}/host-key"), payload);
    }
}

// --------------------------------------------------------------------------
// Commands
// --------------------------------------------------------------------------

/// Check that a host is reachable, authenticates, and runs a supported OS.
///
/// Opens a throwaway session and drops it. Desktop achieved the same isolation
/// with `createSshProbeConnection(config, {mux: false})` so a test could never
/// poison the live ControlMaster; we have no master to poison, but sharing the
/// live session would still mean a failed test could tear down a working
/// connection. Keep this separate.
#[tauri::command]
pub async fn ssh_test(
    app: AppHandle,
    state: State<'_, SshState>,
    attempt_id: String,
    config: SshConnectConfig,
) -> Result<SshTestResult, SshError> {
    let reporter = ProgressReporter::new(app.clone(), &attempt_id);
    let (target, user, mut credentials) = resolve_target(&config.target)?;

    // Normalized, not copied: an untouched secret row reaches us as `""`, and
    // `Some("")` is not `None` downstream — an empty passphrase makes russh
    // attempt a decrypt rather than report `KeyIsEncrypted`, which silently
    // discarded every encrypted key.
    credentials.private_key_pem = auth::nonempty(config.private_key_pem.clone());
    credentials.passphrase = auth::nonempty(config.passphrase.clone());
    credentials.password = auth::nonempty(config.password.clone());

    let attempt = begin_attempt(&state, &attempt_id, Default::default()).await;
    let (prompter, policy) = arm_prompts(&app, &attempt_id, &attempt, config.interactive);
    let known_hosts_path = known_hosts_path(&app)?;

    reporter.step(SshStep::Connecting);

    let options = ConnectOptions {
        credentials,
        policy,
        known_hosts_path,
        home: home_dir(),
        connect_timeout: DEFAULT_CONNECT_TIMEOUT,
    };

    let host_label = target.label();
    let result = async {
        // Reported like `ssh_connect` does: auth is where a Test spends its time
        // when a passphrase or password prompt is waiting, and labelling that
        // "Connecting" makes an answerable dialog look like a stalled dial.
        reporter.step(SshStep::Authenticating);
        let session = SshSession::open(target, user, options, prompter.as_ref()).await?;

        reporter.step(SshStep::ProbingPlatform);
        let uname = session
            .exec_fenced("uname -s; uname -m", None)
            .await?
            .require_success("uname")?;

        let mut lines = uname.lines().map(str::trim).filter(|l| !l.is_empty());
        let platform = lines.next().map(str::to_string);
        let arch = lines.next().map(str::to_string);

        // Drop the probe session immediately — it exists only to answer this.
        let _ = session.close().await;

        Ok::<_, SshError>((platform, arch))
    }
    .await;

    end_attempt(&state, &attempt_id, &attempt).await;

    let (platform, arch) = result?;

    Ok(SshTestResult {
        reachable: true,
        host_label,
        platform,
        arch,
    })
}

/// Install Hermes on the remote host.
///
/// A separate command rather than a branch inside `establish`, on purpose. The
/// user confirms this AFTER a connect has already failed with `HermesNotFound`,
/// so nothing on the path every existing SSH connection takes changes — and
/// installing onto someone else's machine stays an explicit, deliberate act
/// rather than something a mistyped hostname can trigger.
///
/// Shaped like `ssh_test`: resolve, arm prompts (so a key passphrase or password
/// can still be asked for), open a session that exists only for this job, and
/// close it when done. Progress rides the same `hermes-install://{id}/event`
/// channel as the local install, so the frontend reducer is shared.
#[tauri::command]
pub async fn ssh_install(
    app: AppHandle,
    state: State<'_, SshState>,
    attempt_id: String,
    config: SshConnectConfig,
    repo: crate::local_install::script::Repo,
    branch: Option<String>,
) -> Result<(), SshError> {
    let branch = branch
        .map(|b| b.trim().to_string())
        .filter(|b| !b.is_empty())
        .unwrap_or_else(|| crate::local_install::DEFAULT_BRANCH.to_string());

    let (target, user, mut credentials) = resolve_target(&config.target)?;

    // Normalized, not copied: an untouched secret row reaches us as `""`, and
    // `Some("")` is not `None` downstream — an empty passphrase makes russh
    // attempt a decrypt rather than report `KeyIsEncrypted`, which silently
    // discarded every encrypted key.
    credentials.private_key_pem = auth::nonempty(config.private_key_pem.clone());
    credentials.passphrase = auth::nonempty(config.passphrase.clone());
    credentials.password = auth::nonempty(config.password.clone());

    let attempt = begin_attempt(&state, &attempt_id, Default::default()).await;
    let (prompter, policy) = arm_prompts(&app, &attempt_id, &attempt, config.interactive);
    let known_hosts_path = known_hosts_path(&app)?;

    let options = ConnectOptions {
        credentials,
        policy,
        known_hosts_path,
        home: home_dir(),
        connect_timeout: DEFAULT_CONNECT_TIMEOUT,
    };

    let result = async {
        let session = SshSession::open(target, user, options, prompter.as_ref()).await?;
        let outcome = install::install_remote(&session, &app, &attempt_id, repo, &branch).await;

        // Close regardless: the tunnel this install enables is dialled by a
        // separate, later connect.
        let _ = session.close().await;

        outcome
    }
    .await;

    end_attempt(&state, &attempt_id, &attempt).await;

    match result {
        Ok(_) => Ok(()),
        Err(error) => {
            use tauri::Emitter;

            // `install_remote` already emitted a stage-scoped Failed for anything
            // it reached; this covers the rest (auth, host key, transport).
            let _ = app.emit(
                &crate::local_install::events::InstallEvent::channel(&attempt_id),
                crate::local_install::events::InstallEvent::Failed {
                    stage: None,
                    error: error.message.clone(),
                },
            );

            Err(error)
        }
    }
}

/// Every concrete `Host` alias in `~/.ssh/config`, for the settings dropdown.
/// Empty on mobile, where there is no config to read.
#[tauri::command]
pub async fn ssh_list_config_hosts() -> Result<Vec<String>, SshError> {
    let home = home_dir();

    let Some(path) = config::default_config_path(home.as_deref()) else {
        return Ok(Vec::new());
    };

    Ok(config::list_host_aliases(
        &path,
        home.as_deref(),
        &config::FsConfigReader,
    ))
}

/// What `~/.ssh/config` resolves an alias to. Replaces desktop's `ssh -G`.
#[tauri::command]
pub async fn ssh_resolve_host(host: String) -> Result<SshResolvedHost, SshError> {
    let home = home_dir();

    let Some(path) = config::default_config_path(home.as_deref()) else {
        return Ok(SshResolvedHost::default());
    };

    Ok(describe_resolved(config::resolve_host(
        &host,
        &path,
        home.as_deref(),
        &config::FsConfigReader,
    )))
}

/// Flatten a resolved Host block into what the settings form shows.
///
/// The point of the `unsupported` list is that the form can say so out loud. A
/// directive we parsed but do not honour changes where the connection actually
/// lands, so leaving it invisible would be worse than not parsing it at all.
fn describe_resolved(resolved: config::ResolvedHost) -> SshResolvedHost {
    let mut unsupported = resolved.unsupported.clone();

    if resolved.proxy_jump.is_some() {
        unsupported.push("ProxyJump".to_string());
    }

    if resolved.proxy_command.is_some() {
        unsupported.push("ProxyCommand".to_string());
    }

    SshResolvedHost {
        hostname: resolved.hostname,
        user: resolved.user,
        port: resolved.port,
        identity_file: resolved.identity_file,
        unsupported,
    }
}

/// Deliver an answer to a prompt raised by an in-flight attempt.
#[tauri::command]
pub async fn ssh_answer_prompt(
    state: State<'_, SshState>,
    attempt_id: String,
    prompt_id: String,
    answer: String,
) -> Result<(), SshError> {
    let attempt = state
        .attempts
        .lock()
        .await
        .get(&attempt_id)
        .cloned()
        .ok_or_else(|| {
            SshError::new(
                SshErrorKind::Cancelled,
                "That connection attempt is no longer running.",
            )
        })?;

    let responder = attempt
        .pending
        .lock()
        .await
        .remove(&prompt_id)
        .ok_or_else(|| {
            SshError::new(SshErrorKind::Cancelled, "That prompt is no longer waiting.")
        })?;

    // A closed receiver means the prompt already timed out; not worth surfacing.
    let _ = responder.send(answer);

    Ok(())
}

/// Answer a host-key trust question.
#[tauri::command]
pub async fn ssh_trust_host_key(
    state: State<'_, SshState>,
    attempt_id: String,
    accept: bool,
) -> Result<(), SshError> {
    let attempt = state
        .attempts
        .lock()
        .await
        .get(&attempt_id)
        .cloned()
        .ok_or_else(|| {
            SshError::new(
                SshErrorKind::Cancelled,
                "That connection attempt is no longer running.",
            )
        })?;

    let responder = attempt
        .pending_host_key
        .lock()
        .await
        .take()
        .ok_or_else(|| {
            SshError::new(SshErrorKind::Cancelled, "No host-key decision is pending.")
        })?;

    let _ = responder.send(accept);

    Ok(())
}

/// Abandon an in-flight attempt.
#[tauri::command]
pub async fn ssh_cancel(state: State<'_, SshState>, attempt_id: String) -> Result<(), SshError> {
    cancel_in(&state, &attempt_id).await;

    Ok(())
}

/// Drop the session for a scope.
///
/// This closes the tunnel, not the remote backend — the backend is detached on
/// purpose so the next connect reuses it. Only an explicit cleanup, once
/// ownership is proven, may terminate it.
#[tauri::command]
pub async fn ssh_disconnect(
    app: AppHandle,
    state: State<'_, SshState>,
    profile: Option<String>,
    connection_id: Option<String>,
) -> Result<(), SshError> {
    // One backend per connection: the profile no longer names a scope.
    let _ = (state, profile);
    let registered = connection_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string);
    let scope = registered
        .or_else(|| crate::connections::legacy_ssh_connection_id(&app))
        .and_then(|id| crate::tunnels::key_for(&app, &id))
        .unwrap_or_else(|| registry_scope_of(connection_id.as_deref(), None));

    // Releases the PRIMARY hold only (MJXHRM-592): a scope a background lease
    // still holds keeps its session. A scope the tunnel book never saw is torn
    // down exactly as before.
    if !crate::tunnels::release_primary(&app, &scope).await {
        teardown_scope(&app, &scope).await;
    }

    Ok(())
}

/// Drop everything a scope holds: its auth entry FIRST, then the forward (which
/// frees the port), the browser's leases, and the session.
pub(crate) async fn teardown_scope(app: &AppHandle, scope: &str) {
    let state = app.state::<SshState>();

    if let Some(previous) = state.connections.lock().await.remove(scope) {
        app.state::<crate::transport::TransportState>()
            .forget_tunnel_auth(&previous.base_url);
    }

    state.forwards.lock().await.remove(scope);

    // The in-app browser's dev-server tunnels ride this session too
    // (MJXHRM-447). A new host must never inherit a tunnel into the old one.
    crate::browser::drop_reach_scope(app, scope).await;

    let session = state.sessions.lock().await.remove(scope);

    if let Some(session) = session {
        let _ = session.close().await;
    }
}

/// How often the watchdog checks that a session is still up. Cheap — it reads a
/// flag, it does not touch the network.
const SESSION_WATCH_INTERVAL: std::time::Duration = std::time::Duration::from_secs(5);

/// Notice when a tunnel dies and tell the frontend.
///
/// This exists because a dead SSH tunnel is a failure mode the ordinary
/// reconnect cannot recover from. The supervisor re-dials the WebSocket against
/// `http://127.0.0.1:<ephemeral>`, but if the session is gone that port is dead
/// forever — the loop just backs off to 30s and spins. And the tunnel dying is
/// not exotic: sleep/wake, a NAT timeout, or Android reclaiming a backgrounded
/// socket all do it.
///
/// Holds a `Weak`, not an `Arc`, for two reasons: it must not keep the session
/// alive, and an ordinary `ssh_disconnect` must not look like a failure. When
/// the app drops the session deliberately the upgrade fails and this exits
/// quietly, so only an *unexpected* death emits.
async fn watch_session(app: AppHandle, scope: String, session: std::sync::Weak<SshSession>) {
    use tauri::Emitter;

    loop {
        tokio::time::sleep(SESSION_WATCH_INTERVAL).await;

        let Some(session) = session.upgrade() else {
            // Dropped on purpose. Nothing to report.
            return;
        };

        if !session.is_alive() {
            // A session a redial already replaced is not this scope's death.
            let current = app
                .state::<SshState>()
                .sessions
                .lock()
                .await
                .get(&scope)
                .is_some_and(|live| Arc::ptr_eq(live, &session));

            if !current {
                return;
            }

            log::warn!("ssh: the session for scope {scope:?} died; the tunnel is gone");

            // Same reason as `ssh_disconnect`: the browser's leases died with
            // the session, and their ephemeral ports are gone forever.
            crate::browser::drop_reach_scope(&app, &scope).await;

            let _ = app.emit(&format!("ssh://{scope}/disconnected"), ());

            crate::tunnels::on_dead(&app, &scope);

            return;
        }
    }
}

/// 32 hex characters of randomness — the session token's shape.
fn mint_token() -> String {
    let mut buf = [0u8; 32];
    getrandom::getrandom(&mut buf).ok();

    hex::encode(buf)
}

/// 16 hex characters — the spawn nonce's shape.
fn mint_nonce() -> String {
    let mut buf = [0u8; 8];
    getrandom::getrandom(&mut buf).ok();

    hex::encode(buf)
}

/// Establish, or reattach to, a remote backend and tunnel to it.
///
/// The order here is load-bearing in two places, both of which cost a stranded
/// process on someone else's machine if they are rearranged:
///
///   1. The ownership record is written with `port: 0` **immediately** after
///      spawn, before readiness. If the attempt dies in that window and its
///      cleanup cannot reach the box, the next connect still finds a record it
///      can prove ownership through and reap. Without it, the orphan is
///      unreapable — nothing else ties that pid to us.
///   2. Every failure after the spawn runs `cleanup_stale`, which kills the
///      process only once it is provably ours.
#[tauri::command]
pub async fn ssh_connect(
    app: AppHandle,
    state: State<'_, SshState>,
    attempt_id: String,
    config: SshConnectConfig,
) -> Result<SshConnection, SshError> {
    use crate::tunnels::{Hold, SlotKind, SlotSpec};

    let registered = config
        .connection_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string);
    // The legacy owner dials with no id; its row id is still what a lease names.
    let slot_connection_id = registered
        .clone()
        .or_else(|| crate::connections::legacy_ssh_connection_id(&app))
        .unwrap_or_else(|| primary_scope(&config));

    let (instance_key, fingerprint) = identity_for(&config.target)?;
    let spec = SlotSpec {
        connection_id: slot_connection_id.clone(),
        kind: SlotKind::Ssh,
        instance_key,
        fingerprint: fingerprint.clone(),
    };
    // A live slot of this connection is adopted whatever profile it was dialled
    // for: one backend serves every profile.
    let key = crate::tunnels::key_for(&app, &slot_connection_id)
        .unwrap_or_else(|| primary_scope(&config));
    let alive = state
        .sessions
        .lock()
        .await
        .get(&key)
        .is_some_and(|session| session.is_alive());

    let mut dial = match crate::tunnels::hold_primary(
        &app,
        &key,
        spec,
        alive,
        config.interactive,
        &attempt_id,
    )
    // Quitting is a cancel. A refusal fails as the dial it stands in for did.
    .map_err(|e| match e.kind {
        crate::tunnels::FailureKind::Unavailable => {
            SshError::new(SshErrorKind::Cancelled, e.message)
        }
        kind => SshError::new(ssh_kind_of(kind), e.message),
    })? {
        Hold::Reuse(key) => return live_connection(&state, &key).await,
        Hold::Join(key, rx) => {
            crate::tunnels::wait(rx)
                .await
                .map_err(|e| SshError::new(ssh_kind_of(e.kind), e.message))?;

            return live_connection(&state, &key).await;
        }
        Hold::Dial(dial) => dial,
    };

    // Registered before the supersede drain, so a cancel during it is heard.
    let attempt = begin_attempt(&state, &attempt_id, dial.cancel.clone()).await;

    let result = match race_cancel(
        &attempt.cancel,
        crate::tunnels::prepare(&app, &mut dial, SlotKind::Ssh),
    )
    .await
    {
        None => Err(cancelled_error()),
        Some(()) => {
            // A REGISTERED connection's credentials live under keyring accounts
            // the webview cannot name, so Rust reads them here rather than being
            // handed them (rule 4 — a PEM stops crossing IPC). The legacy owner
            // sends no id and keeps passing its arguments, so its dial is
            // unchanged.
            let stored = registered
                .as_deref()
                .and_then(|id| crate::connections::ssh_credentials(&app, id))
                .unwrap_or_default();

            connect_scope(
                &app,
                &state,
                &attempt_id,
                &attempt,
                &dial.key,
                config,
                stored,
            )
            .await
        }
    };

    end_attempt(&state, &attempt_id, &attempt).await;

    // The legacy owner's reattach token is written by JS for its own dials.
    let settled = settle_scope(
        &app,
        &state,
        &dial.key,
        dial.serial,
        &slot_connection_id,
        registered.is_some(),
        result,
    )
    .await;

    let Err(error) = settled else {
        return settled;
    };

    // Who the key belongs to now. Joining is how a supersede, a restart or a
    // newer PRIMARY attempt at the same target keeps the primary from failing
    // and releasing its hold under the dial that replaced it.
    let successor = verdict_outcome(
        crate::tunnels::join_dial(&app, &dial.key, dial.serial, &fingerprint),
        error,
    )?;

    crate::tunnels::wait(successor)
        .await
        .map_err(|e| SshError::new(ssh_kind_of(e.kind), e.message))?;

    live_connection(&state, &dial.key).await
}

/// What the book's verdict does with a caller whose dial failed: a successor to
/// wait on, or the error to fail with.
///
/// Pure, and the tail's only copy of this mapping, so the one thing that must
/// never drift is testable without an app: a QUIET verdict fails with the
/// witness attached — that attempt publishes, so JS neither tears down nor
/// writes atoms over the live connection — while a FAIL hands back the error
/// byte for byte, whatever kind `settle_scope` chose, so its caller resolves its
/// own UI.
fn verdict_outcome(
    joined: crate::tunnels::Joined,
    error: SshError,
) -> Result<tokio::sync::watch::Receiver<crate::tunnels::Outcome>, SshError> {
    match joined {
        crate::tunnels::Joined::Successor(successor) => Ok(successor),
        crate::tunnels::Joined::Quiet(witness) => Err(SshError::quiet(witness, error)),
        crate::tunnels::Joined::Fail => Err(error),
    }
}

fn cancelled_error() -> SshError {
    SshError::new(
        SshErrorKind::Cancelled,
        "The connection attempt was cancelled.",
    )
}

/// The scope a primary dial lives at: the connection's, never the profile's.
fn primary_scope(config: &SshConnectConfig) -> String {
    registry_scope_of(config.connection_id.as_deref(), None)
}

/// The profile a remote backend is launched as. Always `default`: that is the
/// backend's unified server, which serves every profile by the `profile`
/// parameter (`hermes_cli/main_dashboard.py`), so the profile a connection was
/// opened on is only the one preselected in the UI.
fn launch_profile(_preselected: Option<&str>) -> &'static str {
    "default"
}

/// The SSH kind a tunnel failure came from, for a primary that joined a dial.
fn ssh_kind_of(kind: crate::tunnels::FailureKind) -> SshErrorKind {
    use crate::tunnels::FailureKind;

    match kind {
        FailureKind::CredentialsNeeded | FailureKind::Locked => SshErrorKind::AuthFailed,
        FailureKind::HostKeyChanged => SshErrorKind::HostKeyChanged,
        FailureKind::Cancelled => SshErrorKind::Cancelled,
        FailureKind::HermesNotFound => SshErrorKind::HermesNotFound,
        FailureKind::UpdateRequired => SshErrorKind::UpdateRequired,
        FailureKind::UnsupportedPlatform => SshErrorKind::UnsupportedPlatform,
        FailureKind::Unavailable | FailureKind::Transient => SshErrorKind::TransientTransportError,
    }
}

async fn live_connection(state: &SshState, scope: &str) -> Result<SshConnection, SshError> {
    state
        .connections
        .lock()
        .await
        .get(scope)
        .cloned()
        .ok_or_else(|| {
            SshError::new(
                SshErrorKind::TransientTransportError,
                "The shared SSH tunnel closed before it could be adopted.",
            )
        })
}

/// A target's instance key and dial fingerprint, after `~/.ssh/config` has had
/// its say.
pub(crate) fn identity_for(input: &SshTargetInput) -> Result<(String, String), SshError> {
    let (target, user, _) = resolve_target(input)?;
    let port = target.effective_port();

    Ok((
        crate::tunnels::ssh_instance_key(&user, &target.host, port),
        crate::tunnels::ssh_fingerprint(
            &user,
            &target.host,
            port,
            target.key_path.as_deref(),
            target.remote_hermes_path.as_deref(),
        ),
    ))
}

/// Dial a registered SSH connection for a background lease (MJXHRM-592), and
/// settle the result.
///
/// Everything comes from the registry row and Rust's own keyring reads. Never
/// prompts unless `interactive`: a locked store or a missing passphrase is a
/// terminal failure the UI turns into "Needs sign-in".
pub(crate) async fn dial_tunnel(
    app: &AppHandle,
    mut dial: crate::tunnels::Dial,
    connection_id: &str,
    installation_id: Option<String>,
    interactive: bool,
    attempt_id: &str,
) {
    use crate::tunnels::{FailureKind, TunnelError, TunnelTarget};

    let state = app.state::<SshState>();
    // Registered before anything that waits: the supersede drain, the keyring
    // read and the unlock gate all race it, so a dismissed prompt or a newer
    // dial stops this one at any of them.
    let attempt = begin_attempt(&state, attempt_id, dial.cancel.clone()).await;
    let scope = dial.key.clone();
    let serial = dial.serial;

    let prepared = race_cancel(&attempt.cancel, async {
        crate::tunnels::prepare(app, &mut dial, crate::tunnels::SlotKind::Ssh).await;

        let Some(TunnelTarget::Ssh { input, .. }) =
            crate::connections::tunnel_target(app, connection_id)
        else {
            return Err(TunnelError::new(
                FailureKind::Unavailable,
                "that SSH connection is no longer registered",
            ));
        };

        let is_locked = |error: &crate::secrets::SecretsError| {
            error.kind == crate::secrets::error::SecretsErrorKind::Locked
        };

        let stored = match crate::connections::try_ssh_credentials(app, connection_id) {
            Err(error) if is_locked(&error) && interactive => {
                crate::secrets::gate::unlock(
                    "Hermes needs your stored SSH credentials".to_string(),
                )
                .await
                .map_err(|refused| TunnelError::new(FailureKind::Cancelled, refused.message))?;

                crate::connections::try_ssh_credentials(app, connection_id)
                    .map_err(|error| TunnelError::new(FailureKind::Locked, error.message))?
            }
            Err(error) if is_locked(&error) => {
                return Err(TunnelError::new(FailureKind::Locked, error.message))
            }
            other => other.ok().flatten(),
        }
        .unwrap_or_default();

        Ok((input, stored))
    })
    .await
    .unwrap_or_else(|| Err(TunnelError::from_ssh(&cancelled_error())));

    let (input, stored) = match prepared {
        Ok(prepared) => prepared,
        Err(error) => {
            end_attempt(&state, attempt_id, &attempt).await;

            return crate::tunnels::finish_dial(app, &scope, serial, Err(error));
        }
    };

    let config = SshConnectConfig {
        target: input,
        interactive,
        installation_id,
        connection_id: crate::connections::dial_connection_id_of(app, connection_id),
        ..Default::default()
    };

    let result = connect_scope(app, &state, attempt_id, &attempt, &scope, config, stored).await;

    end_attempt(&state, attempt_id, &attempt).await;

    // Nothing in JS saw this dial, so Rust remembers the token for every row.
    let _ = settle_scope(app, &state, &scope, serial, connection_id, true, result).await;
}

/// What a dial built, before it is installed.
struct Established {
    connection: SshConnection,
    forward: forward::PortForward,
    session: Arc<SshSession>,
}

/// Open a session for `scope` and establish or reattach its backend. Installs
/// nothing: see `settle_scope`.
async fn connect_scope(
    app: &AppHandle,
    state: &SshState,
    attempt_id: &str,
    attempt: &Arc<Attempt>,
    scope: &str,
    mut config: SshConnectConfig,
    stored: crate::connections::SshCredentials,
) -> Result<Established, SshError> {
    let _ = state;
    let reporter = ProgressReporter::new(app.clone(), attempt_id);

    let installation_id = config.installation_id.as_deref().ok_or_else(|| {
        SshError::new(
            SshErrorKind::Unknown,
            "This install has no SSH identity yet.",
        )
    })?;

    let ownership_id = ownership::ssh_ownership_id(installation_id, scope)?;

    let (target, user, mut credentials) = resolve_target(&config.target)?;
    // Normalized, not copied: an untouched secret row reaches us as `""`, and
    // `Some("")` is not `None` downstream — an empty passphrase makes russh
    // attempt a decrypt rather than report `KeyIsEncrypted`, which silently
    // discarded every encrypted key.
    credentials.private_key_pem =
        auth::nonempty(config.private_key_pem.clone()).or(stored.private_key_pem);
    credentials.passphrase = auth::nonempty(config.passphrase.clone()).or(stored.passphrase);
    credentials.password = auth::nonempty(config.password.clone()).or(stored.password);
    // The reattach token travels on the config because `establish` reads it
    // there; filling it here keeps that one reader unchanged.
    config.reuse_token = auth::nonempty(config.reuse_token.clone()).or(stored.reuse_token);

    let (prompter, policy) = arm_prompts(app, attempt_id, attempt, config.interactive);
    let host_label = target.label();
    let remote_hermes_path = target.remote_hermes_path.clone();

    reporter.step(SshStep::Connecting);

    let options = ConnectOptions {
        credentials,
        policy,
        known_hosts_path: known_hosts_path(app)?,
        home: home_dir(),
        connect_timeout: DEFAULT_CONNECT_TIMEOUT,
    };

    reporter.step(SshStep::Authenticating);

    // `ssh_cancel` cancels this token; racing it here is what makes a cancel stop
    // the dial. A backend spawned before the cancel stays reapable: its lockfile
    // is written before readiness (see `ssh_connect`'s ordering note).
    let result = unless_cancelled(&attempt.cancel, async {
        let session = Arc::new(SshSession::open(target, user, options, prompter.as_ref()).await?);
        let established = establish(
            &session,
            &ownership_id,
            &config,
            remote_hermes_path.as_deref(),
            &host_label,
            &reporter,
        )
        .await;

        match established {
            Ok(established) => Ok((session, established)),
            Err(err) => {
                let _ = session.close().await;

                Err(err)
            }
        }
    })
    .await;

    match result {
        Ok((session, (mut connection, forward))) => {
            println!(
                "[ssh probe] ssh_connect: succeeded, pid={} reused={} base_url={}",
                connection.pid, connection.reused, connection.base_url
            );

            connection.scope = scope.to_string();

            Ok(Established {
                connection,
                forward,
                session,
            })
        }

        Err(err) => {
            println!(
                "[ssh probe] ssh_connect: failed: {err} (kind={:?})",
                err.kind
            );

            Err(err)
        }
    }
}

/// Install a dial's result if the slot still waits on it, and report it.
///
/// Under the slot's install lock, so a teardown or a superseding dial cannot
/// interleave with the install. A result the slot no longer waits on installs
/// nothing and closes only what that dial built.
async fn settle_scope(
    app: &AppHandle,
    state: &SshState,
    scope: &str,
    serial: u64,
    auth_connection_id: &str,
    remember_token: bool,
    result: Result<Established, SshError>,
) -> Result<SshConnection, SshError> {
    use crate::tunnels::{finish_dial, TunnelError};

    let established = match result {
        Ok(established) => established,
        Err(err) => {
            finish_dial(app, scope, serial, Err(TunnelError::from_ssh(&err)));

            return Err(err);
        }
    };

    let _guard = crate::tunnels::install_lock(app, scope).await;

    if !crate::tunnels::is_current(app, scope, serial) {
        let Established {
            forward, session, ..
        } = established;

        drop(forward);
        let _ = session.close().await;

        let err = SshError::new(
            SshErrorKind::Superseded,
            "A newer connection attempt replaced this one.",
        );

        finish_dial(app, scope, serial, Err(TunnelError::from_ssh(&err)));

        return Err(err);
    }

    let Established {
        connection,
        forward,
        session,
    } = established;
    let transport = app.state::<crate::transport::TransportState>();

    // The previous base's credential goes first, then its forward (which frees
    // the port), then its session. A live session is adopted before any dial,
    // so what is replaced here is dead, superseded or a different target.
    if let Some(previous) = state
        .connections
        .lock()
        .await
        .insert(scope.to_string(), connection.clone())
    {
        transport.forget_tunnel_auth(&previous.base_url);
    }

    transport.set_tunnel_auth(
        &connection.base_url,
        crate::transport::ConnectionAuth {
            connection_id: auth_connection_id.to_string(),
            token: Some(connection.token.clone()),
            headers: Vec::new(),
        },
    );

    state
        .forwards
        .lock()
        .await
        .insert(scope.to_string(), forward);

    let previous = state
        .sessions
        .lock()
        .await
        .insert(scope.to_string(), Arc::clone(&session));

    if let Some(previous) = previous {
        let _ = previous.close().await;
    }

    // Remember the token this backend is running with, per connection. Only on
    // a dial, never on an adopt: one backend per connection has one token.
    if remember_token {
        crate::connections::remember_reuse_token(app, auth_connection_id, &connection.token);
    }

    // Watch for the tunnel dying, which the WS-level reconnect cannot recover
    // from on its own.
    tokio::spawn(watch_session(
        app.clone(),
        scope.to_string(),
        Arc::downgrade(&session),
    ));

    finish_dial(app, scope, serial, Ok(connection.base_url.clone()));

    Ok(connection)
}

/// Run `work` unless the attempt is cancelled first (`None`).
pub(crate) async fn race_cancel<T>(
    cancel: &tokio_util::sync::CancellationToken,
    work: impl std::future::Future<Output = T>,
) -> Option<T> {
    tokio::select! {
        biased;
        () = cancel.cancelled() => None,
        result = work => Some(result),
    }
}

/// `race_cancel` for a step that already fails with an `SshError`.
async fn unless_cancelled<T>(
    cancel: &tokio_util::sync::CancellationToken,
    work: impl std::future::Future<Output = Result<T, SshError>>,
) -> Result<T, SshError> {
    race_cancel(cancel, work)
        .await
        .unwrap_or_else(|| Err(cancelled_error()))
}

/// The lifecycle proper, once a session is open.
async fn establish(
    session: &Arc<SshSession>,
    ownership_id: &str,
    config: &SshConnectConfig,
    remote_hermes_path: Option<&str>,
    host_label: &str,
    reporter: &ProgressReporter,
) -> Result<(SshConnection, forward::PortForward), SshError> {
    reporter.step(SshStep::ProbingPlatform);

    let (platform, windows_runtime) =
        windows_lifecycle::detect_remote_platform(session, remote_hermes_path.unwrap_or_default())
            .await?;
    println!(
        "[ssh probe] establish: platform={:?} arch={:?} windows={}",
        platform.os,
        platform.arch,
        windows_runtime.is_some()
    );

    let profile = launch_profile(config.profile.as_deref()).to_string();
    let reuse_token = config.reuse_token.clone().unwrap_or_default();
    let client = reqwest::Client::new();

    if let Some(runtime) = windows_runtime {
        return establish_windows(
            session,
            runtime,
            ownership_id,
            &profile,
            &reuse_token,
            &platform,
            host_label,
            &client,
            reporter,
        )
        .await;
    }

    let (hermes_path, hermes_version, hermes_home) =
        posix_lifecycle::survey_hermes(session, remote_hermes_path, reporter).await?;
    println!("[ssh probe] establish: hermes_path={hermes_path:?} version={hermes_version:?} home={hermes_home:?}");

    reporter.step(SshStep::CheckingExisting);

    if let Some(lock) = posix_lifecycle::read_lockfile(session, ownership_id).await? {
        let pid_alive = posix_lifecycle::remote_pid_alive(session, lock.pid).await?;
        let owned = pid_alive
            && posix_lifecycle::pid_is_our_dashboard(
                session,
                lock.pid,
                &lock.spawn_nonce,
                &lock.hermes_path,
            )
            .await?;
        let reusable = posix_lifecycle::lock_is_reusable(
            &lock,
            pid_alive,
            owned,
            &reuse_token,
            &hermes_path,
            &hermes_home,
        );
        println!(
            "[ssh probe] establish: existing lock pid={} pid_alive={pid_alive} owned={owned} reusable={reusable}",
            lock.pid
        );

        if reusable {
            reporter.step(SshStep::Forwarding);
            let forward = forward::open(Arc::clone(session), lock.port).await?;
            let base_url = forward.base_url();
            println!(
                "[ssh probe] establish: opened tunnel to remote port={} -> {base_url}",
                lock.port
            );

            reporter.step(SshStep::Verifying);

            let reuse_result =
                reuse::probe_reuse_proof(&client, &base_url, &reuse_token, &lock.spawn_nonce).await;
            println!("[ssh probe] establish: reuse probe -> {reuse_result:?}");

            match reuse_result {
                Ok(reuse::ReuseClassification::AuthenticatedOk) => {
                    let token =
                        adopt_token(&client, session, &base_url, &reuse_token, lock.pid).await?;

                    return Ok((
                        SshConnection {
                            ws_url: ws_url_for(&base_url, &token),
                            base_url,
                            token,
                            local_port: forward.local_port,
                            remote_port: lock.port,
                            pid: lock.pid,
                            reused: true,
                            remote_platform: platform.os.clone(),
                            remote_arch: platform.arch.clone(),
                            hermes_path,
                            hermes_version,
                            ownership_id: ownership_id.to_string(),
                            host_label: host_label.to_string(),
                            scope: String::new(),
                        },
                        forward,
                    ));
                }

                Ok(reuse::ReuseClassification::AuthenticatedStale) => {
                    // Something is on that port, but it is not the backend our
                    // record describes. Drop the tunnel and reap before respawning.
                    drop(forward);
                    posix_lifecycle::cleanup_stale(session, ownership_id, &lock, pid_alive).await?;
                }

                Err(err) => {
                    // A transport blip is not evidence about ownership; leave the
                    // backend alone and let the caller retry.
                    println!("[ssh probe] establish: reuse probe failed, giving up on this attempt: {err}");
                    drop(forward);

                    return Err(err);
                }
            }
        } else {
            posix_lifecycle::cleanup_stale(session, ownership_id, &lock, pid_alive).await?;
        }
    }

    println!("[ssh probe] establish: no reusable backend, spawning a new one");
    spawn_and_attach(
        session,
        ownership_id,
        &profile,
        &hermes_path,
        &hermes_version,
        &hermes_home,
        &platform,
        host_label,
        &client,
        reporter,
    )
    .await
}

/// The same lifecycle against a remote host running Windows.
///
/// Structurally identical to the POSIX path — probe, check the lock, reuse or
/// respawn, tunnel, verify — but every remote step goes through
/// `hermes_cli.windows_ssh_runtime` instead of shell commands, and identity is
/// `pid + creationTimeNs` rather than `pid + /proc/<pid>/cmdline`.
#[allow(clippy::too_many_arguments)]
async fn establish_windows(
    session: &Arc<SshSession>,
    mut runtime: windows_lifecycle::WindowsRuntime,
    ownership_id: &str,
    profile: &str,
    reuse_token: &str,
    platform: &posix_lifecycle::RemotePlatform,
    host_label: &str,
    client: &reqwest::Client,
    reporter: &ProgressReporter,
) -> Result<(SshConnection, forward::PortForward), SshError> {
    reporter.step(SshStep::LocatingHermes);
    let hermes_version = windows_lifecycle::inspect_install(session, &mut runtime).await?;
    reporter.step_with(
        SshStep::LocatingHermes,
        format!("found hermes at {}", runtime.hermes_path),
    );

    reporter.step(SshStep::CheckingExisting);

    if let Some(lock) = windows_lifecycle::read_lock(session, &runtime, ownership_id).await? {
        let state = windows_lifecycle::process_state(session, &runtime, &lock).await?;

        // Safety rule 1 again, at the reuse gate: without a definite answer we
        // must neither reattach nor tear down. Retry rather than guess.
        if state.indeterminate {
            return Err(SshError::new(
                SshErrorKind::TransientTransportError,
                "Could not determine the state of the existing remote backend.",
            ));
        }

        let reusable = windows_lifecycle::lock_is_reusable(
            &lock,
            &state,
            reuse_token,
            &runtime.hermes_path,
            &runtime.hermes_home,
        );

        if reusable {
            reporter.step(SshStep::Forwarding);
            let forward = forward::open(Arc::clone(session), lock.port).await?;
            let base_url = forward.base_url();

            reporter.step(SshStep::Verifying);

            match reuse::probe_reuse_proof(client, &base_url, reuse_token, &lock.spawn_nonce).await
            {
                Ok(reuse::ReuseClassification::AuthenticatedOk) => {
                    return Ok((
                        SshConnection {
                            ws_url: ws_url_for(&base_url, reuse_token),
                            base_url,
                            token: reuse_token.to_string(),
                            local_port: forward.local_port,
                            remote_port: lock.port,
                            pid: lock.pid,
                            reused: true,
                            remote_platform: platform.os.clone(),
                            remote_arch: platform.arch.clone(),
                            hermes_path: runtime.hermes_path.clone(),
                            hermes_version,
                            ownership_id: ownership_id.to_string(),
                            host_label: host_label.to_string(),
                            scope: String::new(),
                        },
                        forward,
                    ));
                }

                Ok(reuse::ReuseClassification::AuthenticatedStale) => {
                    drop(forward);
                    windows_lifecycle::cleanup_owned(session, &runtime, ownership_id, Some(&lock))
                        .await?;
                }

                Err(err) => {
                    drop(forward);

                    return Err(err);
                }
            }
        } else {
            windows_lifecycle::cleanup_owned(session, &runtime, ownership_id, Some(&lock)).await?;
        }
    }

    let token = mint_token();
    let spawn_nonce = mint_nonce();

    let spawned = windows_lifecycle::spawn_backend(
        session,
        &runtime,
        ownership_id,
        &spawn_nonce,
        profile,
        &token,
        reporter,
    )
    .await?;

    let mut lock = windows_lifecycle::WindowsLock {
        schema_version: remote_paths::LOCKFILE_SCHEMA_VERSION,
        protocol_version: remote_paths::PROTOCOL_VERSION,
        ownership_id: ownership_id.to_string(),
        spawn_nonce: spawn_nonce.clone(),
        pid: spawned.pid,
        creation_time_ns: spawned.creation_time_ns.clone(),
        // Deliberately 0 until readiness — see the ordering note on `ssh_connect`.
        port: 0,
        token_fingerprint: ownership::fingerprint_token(&token),
        profile: profile.to_string(),
        hermes_path: runtime.hermes_path.clone(),
        hermes_home: runtime.hermes_home.clone(),
        started_at: clock::now_iso8601(),
    };

    let attached = attach_windows(
        session,
        &runtime,
        ownership_id,
        &mut lock,
        &token,
        client,
        reporter,
    )
    .await;

    match attached {
        Ok((remote_port, forward)) => Ok((
            SshConnection {
                ws_url: ws_url_for(&forward.base_url(), &token),
                base_url: forward.base_url(),
                token,
                local_port: forward.local_port,
                remote_port,
                pid: spawned.pid,
                reused: false,
                remote_platform: platform.os.clone(),
                remote_arch: platform.arch.clone(),
                hermes_path: runtime.hermes_path.clone(),
                hermes_version,
                ownership_id: ownership_id.to_string(),
                host_label: host_label.to_string(),
                scope: String::new(),
            },
            forward,
        )),

        Err(err) => {
            let _ = windows_lifecycle::cleanup_owned(session, &runtime, ownership_id, Some(&lock))
                .await;

            Err(err)
        }
    }
}

/// Record ownership, wait for readiness, tunnel, and confirm — Windows edition.
#[allow(clippy::too_many_arguments)]
async fn attach_windows(
    session: &Arc<SshSession>,
    runtime: &windows_lifecycle::WindowsRuntime,
    ownership_id: &str,
    lock: &mut windows_lifecycle::WindowsLock,
    token: &str,
    client: &reqwest::Client,
    reporter: &ProgressReporter,
) -> Result<(u16, forward::PortForward), SshError> {
    // Written before readiness so a failure in the next few seconds still leaves
    // a reapable record. See the ordering note on `ssh_connect`.
    windows_lifecycle::write_lock(session, runtime, ownership_id, lock).await?;

    reporter.step(SshStep::WaitingReady);
    let remote_port = windows_lifecycle::wait_ready(
        session,
        runtime,
        ownership_id,
        lock,
        windows_lifecycle::DEFAULT_READY_TIMEOUT,
    )
    .await?;

    reporter.step(SshStep::Forwarding);
    let forward = forward::open(Arc::clone(session), remote_port).await?;

    reporter.step(SshStep::Verifying);
    reuse::wait_for_hermes(client, &forward.base_url(), token).await?;

    lock.port = remote_port;
    windows_lifecycle::write_lock(session, runtime, ownership_id, lock).await?;

    Ok((remote_port, forward))
}

/// Spawn a fresh backend and tunnel to it.
#[allow(clippy::too_many_arguments)]
async fn spawn_and_attach(
    session: &Arc<SshSession>,
    ownership_id: &str,
    profile: &str,
    hermes_path: &str,
    hermes_version: &str,
    hermes_home: &str,
    platform: &posix_lifecycle::RemotePlatform,
    host_label: &str,
    client: &reqwest::Client,
    reporter: &ProgressReporter,
) -> Result<(SshConnection, forward::PortForward), SshError> {
    let spawn_token = mint_token();
    let spawn_nonce = mint_nonce();

    reporter.step(SshStep::UploadingToken);
    reporter.step(SshStep::Spawning);

    let spawned = posix_lifecycle::spawn_remote_dashboard(
        session,
        hermes_path,
        Some(profile).filter(|p| !p.is_empty()),
        &spawn_token,
        ownership_id,
        &spawn_nonce,
    )
    .await?;

    let mut context = posix_lifecycle::SpawnContext {
        ownership_id,
        spawn_nonce: &spawn_nonce,
        profile,
        hermes_path,
        hermes_home,
        log_path: &spawned.log_path,
        token_fingerprint: ownership::fingerprint_token(&spawn_token),
        pid: spawned.pid,
        // Deliberately 0 — see the ordering note on `ssh_connect`.
        port: 0,
        started_at: clock::now_iso8601(),
    };

    let attached = attach_spawned(
        session,
        ownership_id,
        &spawned,
        &mut context,
        &spawn_token,
        client,
        reporter,
    )
    .await;

    match attached {
        Ok((remote_port, forward, token)) => Ok((
            SshConnection {
                ws_url: ws_url_for(&forward.base_url(), &token),
                base_url: forward.base_url(),
                token,
                local_port: forward.local_port,
                remote_port,
                pid: spawned.pid,
                reused: false,
                remote_platform: platform.os.clone(),
                remote_arch: platform.arch.clone(),
                hermes_path: hermes_path.to_string(),
                hermes_version: hermes_version.to_string(),
                ownership_id: ownership_id.to_string(),
                host_label: host_label.to_string(),
                scope: String::new(),
            },
            forward,
        )),

        Err(err) => {
            // Anything that fails after the spawn must reap the process we just
            // started, or it is stranded on the remote with nothing pointing at it.
            println!("[ssh probe] spawn_and_attach: attach failed after spawning pid={}, reaping it: {err}", spawned.pid);
            posix_lifecycle::remove_token_file(session, &spawned.token_file_path).await;
            let _ = posix_lifecycle::cleanup_stale(session, ownership_id, &context.to_lock(), true)
                .await;

            Err(err)
        }
    }
}

/// Record ownership, wait for readiness, tunnel, and confirm.
async fn attach_spawned(
    session: &Arc<SshSession>,
    ownership_id: &str,
    spawned: &posix_lifecycle::SpawnedBackend,
    context: &mut posix_lifecycle::SpawnContext<'_>,
    spawn_token: &str,
    client: &reqwest::Client,
    reporter: &ProgressReporter,
) -> Result<(u16, forward::PortForward, String), SshError> {
    // First, before anything can go wrong: see the ordering note on `ssh_connect`.
    posix_lifecycle::write_lockfile(
        session,
        ownership_id,
        &context.to_lock(),
        &spawned.spawn_nonce,
    )
    .await?;

    reporter.step(SshStep::WaitingReady);
    let remote_port = posix_lifecycle::wait_for_ready_port(
        session,
        &spawned.log_path,
        spawned.pid,
        posix_lifecycle::DEFAULT_READY_TIMEOUT,
    )
    .await?;

    reporter.step(SshStep::Forwarding);
    let forward = forward::open(Arc::clone(session), remote_port).await?;
    let base_url = forward.base_url();
    println!("[ssh probe] attach_spawned: tunnel open, remote_port={remote_port} -> {base_url}");

    reporter.step(SshStep::Verifying);
    reuse::wait_for_hermes(client, &base_url, spawn_token).await?;
    println!("[ssh probe] attach_spawned: {base_url} answered, adopting token");

    let token = adopt_token(client, session, &base_url, spawn_token, spawned.pid).await?;

    // Now that the port and the real token are known, complete the record.
    context.port = remote_port;
    context.token_fingerprint = ownership::fingerprint_token(&token);
    posix_lifecycle::write_lockfile(
        session,
        ownership_id,
        &context.to_lock(),
        &spawned.spawn_nonce,
    )
    .await?;

    println!("[ssh probe] attach_spawned: done, pid={}", spawned.pid);
    Ok((remote_port, forward, token))
}

/// Reconcile the token we minted against the one the backend actually serves.
///
/// The minted token is only the *spawn* credential. Liveness is sampled **after**
/// the fetch, not before: a served token that differs while our process is dead
/// means something else answered, and adopting its credential would wire the app
/// to a stranger's backend.
async fn adopt_token(
    client: &reqwest::Client,
    session: &SshSession,
    base_url: &str,
    expected: &str,
    pid: i64,
) -> Result<String, SshError> {
    let served = reuse::resolve_served_token(client, base_url, expected).await;
    let alive = posix_lifecycle::remote_pid_alive(session, pid).await?;
    // Never log `served`/`expected` themselves — they're session tokens.
    println!(
        "[ssh probe] adopt_token: pid={pid} alive={alive} served_matches_expected={}",
        served == expected
    );

    if reuse::is_foreign_backend(&served, expected, alive) {
        println!("[ssh probe] adopt_token: refusing — a foreign backend is answering on this port");
        return Err(SshError::new(
            SshErrorKind::AuthenticatedStale,
            "The remote backend exited and something we did not start is answering on its port; \
             refusing that session token.",
        ));
    }

    if !alive {
        println!("[ssh probe] adopt_token: pid={pid} is gone");
        return Err(SshError::new(
            SshErrorKind::Unknown,
            "The remote backend exited while its session token was being resolved.",
        ));
    }

    Ok(served)
}

/// The gateway WebSocket URL for a tunnelled backend.
///
/// `ws:`, not `wss:` — confidentiality comes from the SSH channel, and the
/// remote backend serves no certificate for 127.0.0.1.
fn ws_url_for(base_url: &str, token: &str) -> String {
    format!(
        "{}/api/ws?token={token}",
        base_url.replacen("http", "ws", 1)
    )
}

#[cfg(test)]
mod tests {
    /// Phase 0 gate. Touching both russh's client config and its bundled `keys`
    /// module forces the linker to actually pull the crate (and its crypto
    /// backend) rather than resolving it and dropping it as dead weight, so a
    /// green `cargo test` here is real evidence the `ring`-only feature pin
    /// builds on this target.
    #[test]
    fn russh_links_with_the_ring_backend() {
        let config = russh::client::Config::default();
        // A non-trivial default we depend on later: russh does not enable
        // keepalives by default, so ssh/session.rs must set them explicitly or a
        // half-open TCP after sleep/wake hangs instead of erroring.
        assert_eq!(config.keepalive_interval, None);

        // `russh::keys` is the bundled successor to the stale standalone
        // `russh-keys` crate. Parsing an OpenSSH public key is the exact path
        // ssh/known_hosts.rs takes, and a fixed literal keeps this test free of
        // both RNG and filesystem state.
        let key: russh::keys::PublicKey = TEST_ED25519_PUB
            .parse()
            .expect("ed25519 public keys must parse under the ring backend");

        // A missing known_hosts file must read as "host not known", never as an
        // error — TOFU on a fresh install (and on mobile, where there is no
        // ~/.ssh at all) depends on that distinction.
        let missing = std::path::Path::new("/nonexistent/hermes/known_hosts");
        assert!(
            !russh::keys::check_known_hosts_path("example.invalid", 22, &key, missing)
                .expect("a missing known_hosts file is not an error"),
            "an unknown host must report false, not error"
        );
    }

    /// A throwaway ed25519 public key, generated once for this test. Not a
    /// credential — the matching private half was never kept.
    const TEST_ED25519_PUB: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOGXTILfYe9/k4y5hfEhEtghgFt9121WP+K8hBJssvoS hermes-ssh-test";

    use super::*;

    #[test]
    fn a_remote_backend_is_one_per_connection_and_launches_as_default() {
        let config = SshConnectConfig {
            connection_id: Some("box".to_string()),
            profile: Some("work".to_string()),
            ..Default::default()
        };

        assert_eq!(primary_scope(&config), "conn:box::default");
        assert_eq!(
            primary_scope(&SshConnectConfig {
                profile: Some("work".to_string()),
                ..Default::default()
            }),
            "",
            "the legacy owner reattaches its default backend"
        );

        let launched = launch_profile(config.profile.as_deref());
        let command = posix_lifecycle::build_spawn_command(
            "~/.local/bin/hermes",
            Some(launched),
            "~/.hermes/ssh.log",
            None,
            None,
        )
        .expect("builds");

        assert!(
            // Quoted twice: `shq` for the argument, then again for `sh -c`.
            command.contains(r#"--profile '\''default'\'' serve --isolated"#),
            "{command}"
        );
    }

    #[tokio::test]
    async fn a_cancel_before_the_session_opens_still_stops_the_dial() {
        let state = SshState::default();
        let attempt = begin_attempt(&state, "a1", Default::default()).await;

        // `ssh_cancel` lands while the dial is still draining its predecessor
        // or waiting on the unlock gate.
        cancel_in(&state, "a1").await;

        let outcome = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            race_cancel(&attempt.cancel, std::future::pending::<()>()),
        )
        .await
        .expect("a cancelled attempt stops waiting");

        assert!(outcome.is_none());
    }

    #[tokio::test]
    async fn a_late_superseded_attempt_never_takes_the_newer_ones_id() {
        let state = SshState::default();
        let superseded = tokio_util::sync::CancellationToken::new();

        // The newer dial registered first; the superseded one registers late,
        // its token already cancelled by the book.
        let newer = begin_attempt(&state, "tunnel-box", Default::default()).await;
        superseded.cancel();
        let late = begin_attempt(&state, "tunnel-box", superseded).await;

        assert!(!newer.cancel.is_cancelled());
        assert!(late.cancel.is_cancelled());

        // `ssh_cancel` for the id still reaches the newer attempt.
        cancel_in(&state, "tunnel-box").await;
        assert!(newer.cancel.is_cancelled());
    }

    #[test]
    fn a_fail_verdict_can_never_carry_the_quiet_signal() {
        // What `settle_scope` mints for its own caller when a newer dial won the
        // install race (SSH:1386). Its kind says the work was thrown away; the
        // caller still tears down, so the flag must be absent from the wire.
        let stale = SshError::new(
            SshErrorKind::Superseded,
            "A newer connection attempt replaced this one.",
        );

        assert_eq!(
            serde_json::to_value(&stale).unwrap(),
            serde_json::json!({
                "kind": "superseded",
                "message": "A newer connection attempt replaced this one."
            }),
            "a caller's own failure must not look quiet"
        );

        // Only the book's witness sets it, and it changes nothing else.
        let quiet = SshError::quiet(
            crate::tunnels::Quiet::for_test(),
            SshError::new(SshErrorKind::AuthFailed, "wrong passphrase"),
        );

        assert_eq!(
            serde_json::to_value(&quiet).unwrap(),
            serde_json::json!({
                "kind": "auth-failed",
                "message": "wrong passphrase",
                "quiet": true
            })
        );
    }

    #[test]
    fn only_a_quiet_verdict_marks_the_error_quiet() {
        let failed = || SshError::new(SshErrorKind::Timeout, "the dial timed out");
        let wire = |error: &SshError| serde_json::to_value(error).unwrap();

        // QUIET: the newer primary attempt publishes, so JS must neither tear
        // down nor write phase/connection atoms over the live connection. The
        // witness is the whole signal — dropping it here is invisible in Rust
        // and turns a silent caller into one that clobbers the UI.
        let quiet = verdict_outcome(
            crate::tunnels::Joined::Quiet(crate::tunnels::Quiet::for_test()),
            failed(),
        )
        .expect_err("a quiet verdict fails");

        assert_eq!(
            wire(&quiet),
            serde_json::json!({
                "kind": "timeout",
                "message": "the dial timed out",
                "quiet": true
            })
        );

        // FAIL: the error comes back byte for byte, so its caller tears down.
        let loud = verdict_outcome(crate::tunnels::Joined::Fail, failed())
            .expect_err("a fail verdict fails");

        assert_eq!(wire(&loud), wire(&failed()));
        assert!(wire(&loud).get("quiet").is_none(), "{loud:?}");
    }

    #[tokio::test]
    async fn an_attempt_cancelled_while_it_waits_for_the_lock_never_registers() {
        let state = SshState::default();
        let token = tokio_util::sync::CancellationToken::new();
        let held = state.attempts.lock().await;
        let register = begin_attempt(&state, "tunnel-box", token.clone());

        tokio::pin!(register);

        // Polled once: it is parked on the lock this test holds, token live.
        assert!(
            tokio::time::timeout(std::time::Duration::ZERO, &mut register)
                .await
                .is_err(),
            "the registration waits for the lock"
        );

        // The supersede lands while it waits.
        token.cancel();
        drop(held);

        let attempt = register.await;

        assert!(attempt.cancel.is_cancelled());
        assert!(state.attempts.lock().await.get("tunnel-box").is_none());
    }

    #[tokio::test]
    async fn a_cancelled_attempt_stops_the_dial() {
        let cancel = tokio_util::sync::CancellationToken::new();

        cancel.cancel();

        let outcome = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            unless_cancelled(&cancel, std::future::pending::<Result<(), SshError>>()),
        )
        .await
        .expect("a cancelled attempt returns instead of waiting on the dial");

        assert_eq!(outcome.map_err(|e| e.kind), Err(SshErrorKind::Cancelled));
    }

    #[test]
    fn the_default_profile_and_an_empty_profile_share_one_scope() {
        // Ownership is keyed on this, so two spellings of "no profile" must not
        // produce two remote backends.
        // The legacy arm is byte-identical to the pre-registry `scope_of`.
        assert_eq!(registry_scope_of(None, None), "");
        assert_eq!(registry_scope_of(None, Some("")), "");
        assert_eq!(registry_scope_of(None, Some("work")), "work");
        assert_ne!(
            registry_scope_of(None, Some("work")),
            registry_scope_of(None, Some("home"))
        );
        // …and an empty id is the same as no id, so a frontend that sends `""`
        // does not silently mint a second backend.
        assert_eq!(registry_scope_of(Some(""), Some("work")), "work");
        assert_eq!(registry_scope_of(Some("  "), Some("work")), "work");

        // Two REGISTERED sources on one profile name never share a scope.
        assert_ne!(
            registry_scope_of(Some("box-a"), Some("work")),
            registry_scope_of(Some("box-b"), Some("work"))
        );
        assert_ne!(registry_scope_of(Some("box-a"), Some("work")), "work");
        // A composite can never collide with a bare profile: ':' is invalid in
        // a profile name.
        assert_eq!(
            registry_scope_of(Some("box-a"), Some("work")),
            "conn:box-a::work"
        );
    }

    #[test]
    fn proxy_directives_reach_the_form_as_unsupported() {
        let resolved = config::ResolvedHost {
            hostname: Some("10.0.0.5".into()),
            user: Some("deploy".into()),
            port: Some(2222),
            proxy_jump: Some("bastion".into()),
            ..Default::default()
        };

        let dto = describe_resolved(resolved);
        assert_eq!(dto.hostname.as_deref(), Some("10.0.0.5"));
        assert!(
            dto.unsupported.contains(&"ProxyJump".to_string()),
            "{:?}",
            dto.unsupported
        );
    }

    #[test]
    fn every_unsupported_directive_is_listed_together() {
        let resolved = config::ResolvedHost {
            proxy_jump: Some("bastion".into()),
            proxy_command: Some("nc %h %p".into()),
            unsupported: vec!["Match".into()],
            ..Default::default()
        };

        let dto = describe_resolved(resolved);
        assert_eq!(dto.unsupported.len(), 3, "{:?}", dto.unsupported);
    }

    #[test]
    fn a_clean_host_reports_nothing_unsupported() {
        let dto = describe_resolved(config::ResolvedHost {
            user: Some("deploy".into()),
            ..Default::default()
        });

        assert!(dto.unsupported.is_empty());
        // Absent fields are omitted rather than serialized as null, so the form
        // can tell "not configured" from "configured empty".
        let json = serde_json::to_value(&dto).unwrap();
        assert!(json.get("hostname").is_none(), "{json}");
        assert!(json.get("unsupported").is_none(), "{json}");
    }

    #[test]
    fn connect_config_accepts_the_flattened_target_fields() {
        // The frontend sends one flat object; `#[serde(flatten)]` must absorb the
        // target fields rather than requiring a nested key.
        let config: SshConnectConfig = serde_json::from_value(serde_json::json!({
            "host": "deploy@box.example:2222",
            "keyPath": "/keys/id_ed25519",
            "remoteHermesPath": "/usr/local/bin/hermes",
            "profile": "work",
            "interactive": true
        }))
        .expect("the settings payload must deserialize");

        assert_eq!(config.target.host, "deploy@box.example:2222");
        assert_eq!(config.target.key_path.as_deref(), Some("/keys/id_ed25519"));
        assert_eq!(config.profile.as_deref(), Some("work"));
        assert!(config.interactive);
    }

    #[test]
    fn connect_config_defaults_to_non_interactive() {
        // The boot restore omits the flag, and must NOT be treated as able to
        // answer prompts — nothing is mounted to show them.
        let config: SshConnectConfig =
            serde_json::from_value(serde_json::json!({ "host": "box.example" })).unwrap();

        assert!(!config.interactive);
        assert!(config.private_key_pem.is_none());
    }

    #[test]
    fn a_minted_token_and_nonce_have_the_shapes_the_lockfile_requires() {
        // The lock validator enforces exactly these, so a mismatch here would
        // make every write unreadable on the next connect.
        let token = mint_token();
        assert_eq!(token.len(), 64);
        assert!(
            token
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()),
            "{token}"
        );

        let nonce = mint_nonce();
        assert!(
            remote_paths::validate_spawn_nonce(&nonce).is_ok(),
            "{nonce}"
        );
    }

    #[test]
    fn minted_values_are_not_repeated() {
        // The nonce is what proves a process is ours; a repeat would let one
        // backend be mistaken for another.
        assert_ne!(mint_token(), mint_token());
        assert_ne!(mint_nonce(), mint_nonce());
    }

    #[test]
    fn the_ws_url_rides_the_tunnel_unencrypted() {
        // ws, not wss: confidentiality comes from the SSH channel, and the remote
        // backend serves no certificate for 127.0.0.1.
        let url = ws_url_for("http://127.0.0.1:41337", "abc123");
        assert_eq!(url, "ws://127.0.0.1:41337/api/ws?token=abc123");
        assert!(!url.contains("wss://"));
    }

    #[test]
    fn mobile_reports_no_home_directory() {
        // Android does have a HOME, but it is an app-private sandbox with no
        // ~/.ssh in it; pretending otherwise would send the config reader and the
        // known-hosts store somewhere meaningless.
        //
        // `home_dir()` reads $HOME. No test in this crate writes the environment
        // any more — the ones that used to now inject their values through seams
        // (`repo_scan::imp::resolve_home`, `plugins::resolve_hermes_home`) — so
        // this read needs no serialization. Keep it that way: a `set_var`
        // anywhere in the crate's tests races this `getenv` and every other one.
        if cfg!(target_os = "android") || cfg!(target_os = "ios") {
            assert!(home_dir().is_none());
        } else {
            assert!(
                home_dir().is_some(),
                "a desktop run should resolve a home directory"
            );
        }
    }
}
