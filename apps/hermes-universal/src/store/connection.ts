import { isGatewayReauthRequired } from '@/gateway'
import {
  fetchAuthProviders,
  oauthLogin,
  oauthLogout,
  oauthStatus,
  passwordLogin,
  portalAgentSignIn,
  portalLogout
} from '@/lib/auth'
import { errorText } from '@/lib/error-text'
import { loadString, saveString } from '@/lib/persist'
import { IS_NATIVE_MOBILE } from '@/lib/platform'
import { reconnectBackoffDelayMs } from '@/lib/reconnect-backoff'
import { clearSecrets, loadSecrets, loadSshSecrets, saveSecrets, type Secrets } from '@/lib/secure-store'
import { persistSessionCookies } from '@/lib/session-persist'
import {
  $activeConnection,
  describeConnection,
  publishActiveConnection,
  setPendingConnectionHint,
  takePendingConnectionHint
} from '@/store/active-connection'
import {
  $connection,
  $connectionError,
  $connectionPhase,
  $hasConnected,
  $status,
  type StatusInfo
} from '@/store/connection-atoms'
import { isLatched, latchBackendFailure, releaseLatch } from '@/store/connection-latches'
import { $gatewayState, closeGateway, connectGateway } from '@/store/gateway'
import { chooseGatedAuth, type Connection } from '@/store/gateway-config'
import { loadGatewayTarget, saveGatewayTarget, savePendingOAuth, takePendingOAuth } from '@/store/gateway-restore'
import { getInstallationId } from '@/store/installation-id'
import { spawnLocalBackend, stopLocalBackend } from '@/store/local-backend'
import {
  $sshStep,
  cancelSsh,
  connectSshBackend,
  disconnectSsh,
  newAttemptId,
  onSshDisconnected,
  onSshProgress,
  type SshConnectConfig
} from '@/store/ssh-backend'
import { httpRequest } from '@/transport/http'

// The atoms themselves live in the LEAF `store/connection-atoms.ts` so that
// `lib/api.ts` and `store/active-connection.ts` can read them without pulling in
// the connect/reconnect machinery (and without the import cycle that would
// create). Re-exported here so every existing importer is unchanged.
export {
  $connection,
  $connectionError,
  $connectionPhase,
  $hasConnected,
  $status,
  type ConnectionPhase,
  type StatusInfo
} from '@/store/connection-atoms'
// AuthMode / Connection are now defined in store/gateway-config (the reconciled
// model incl. 'oauth' + gateway mode). Re-exported here so existing importers of
// '@/store/connection' keep working.
export type { AuthMode, Connection } from '@/store/gateway-config'

// The RemoteProvider: resolve a LAN/remote Hermes backend URL + auth, then hold
// the live connection descriptor. All chat traffic then runs over the gateway
// (store/gateway.ts). Remote only — no local-spawn mode on mobile.
//
// Two auth shapes:
//   • token / none  — loopback / non-gated backends (auth_required=false):
//                      WS uses ?token= (or nothing).
//   • ticket         — gated backends (auth_required=true): password-login sets a
//                      session cookie (held in Rust), and the WS uses a fresh
//                      single-use ?ticket= minted per connect (store/gateway.ts).

export interface ConnectInput {
  url: string
  token?: string
  username?: string
  password?: string
}

// Non-secret conveniences live in localStorage for a synchronous prefill; the
// secrets (token/password) live in the OS keyring (see @/lib/secure-store).
const URL_KEY = 'hermes.url'
const USER_KEY = 'hermes.username'

export const lastUrl = (): string => loadString(URL_KEY)
export const lastUsername = (): string => loadString(USER_KEY)

/** Read the saved token/password from the keyring (silent; null if none). */
export function loadSavedLogin(): Promise<Secrets | null> {
  return loadSecrets()
}

/** Forget the saved secrets (e.g. a "sign out everywhere" affordance).
 *
 *  Resolves false when the wipe did not land — the keystore was unreachable, or
 *  it refused. Callers that tell the user they are signed out everywhere should
 *  check: a failed wipe used to be indistinguishable from a clean one. */
export function forgetSavedLogin(): Promise<boolean> {
  return clearSecrets()
}

/** The registry id of whatever is live, for the saved target. Read AFTER the
 *  publish, so it names the connection that actually came up. */
function activeConnectionId(): string | undefined {
  return $activeConnection.get()?.connectionId
}

export function normalizeBaseUrl(raw: string): string {
  let value = raw.trim()

  if (!/^https?:\/\//i.test(value)) {
    value = `http://${value}`
  }

  return value.replace(/\/+$/, '')
}

/** Probe /api/status WITHOUT credentials to learn how the backend authenticates. */
export async function probeStatus(rawUrl: string): Promise<StatusInfo> {
  const base = normalizeBaseUrl(rawUrl)
  const res = await httpRequest('GET', `${base}/api/status`, { timeoutMs: 8000 })

  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Backend responded HTTP ${res.status}`)
  }

  return JSON.parse(res.body) as StatusInfo
}

/**
 * Drive the interactive gateway OAuth sign-in.
 *
 * On desktop this opens a dedicated sign-in window and the promise resolves when the
 * session lands. On ANDROID AND iOS the Rust command navigates the CALLING webview to the
 * login and back (neither phone can host a dismissable second window — see
 * src-tauri/src/oauth.rs); that navigation destroys this JS context, so `oauthLogin` never
 * resolves here. We persist a one-shot resume marker FIRST so the post-reload boot
 * (`autoRestoreConnection`) finishes the connect. Callers must treat this as "may never
 * return" on mobile.
 *
 * Both mobile flows navigate away — the RFC 8252 one to `/auth/native/authorize`, the
 * cookie cascade to `/auth/login` — so the marker is right for either.
 */
async function beginOAuthLogin(base: string, provider?: string, username?: string): Promise<void> {
  if (!IS_NATIVE_MOBILE) {
    await oauthLogin(base, provider)

    return
  }

  // The marker carries the SOURCE (MJXHRM-446). The navigation destroys this JS
  // context, so without an id the post-reload resume can only guess which
  // gateway it just signed into — and on a multi-source install a guess means
  // coming back on the wrong machine.
  savePendingOAuth({ base, connectionId: $activeConnection.get()?.connectionId, provider, username })

  try {
    await oauthLogin(base, provider)
  } catch (err) {
    // A REJECTION on mobile means we never navigated (Rust failed to bind the loopback
    // listener, or the webview refused the load) — this JS context is still alive and
    // the caller is about to surface the error. The marker we parked is now garbage
    // that would otherwise sit in localStorage and fire on some unrelated later launch,
    // seeding `$restoring` and sending the boot down the resume branch for a sign-in
    // that never happened.
    takePendingOAuth()

    throw err
  }
}

export async function connect(input: ConnectInput): Promise<void> {
  const base = normalizeBaseUrl(input.url)
  // Taken SYNCHRONOUSLY, before the first await. The hint is one-shot and
  // `selectConnection` parks it immediately before calling this, so two
  // overlapping switches would otherwise each publish whichever identity was
  // parked last.
  const hint = takePendingConnectionHint()

  armReconnect()
  $connectionError.set(null)
  $connectionPhase.set('probing')

  try {
    const status = await probeStatus(base)
    $status.set(status)

    let conn: Connection
    let oauthProvider: string | undefined

    if (status.auth_required) {
      // Gated: pick the concrete path from the advertised providers. Password
      // login (→ ticket) wins only when the operator supplied credentials AND a
      // provider supports it; otherwise the interactive OAuth path.
      $connectionPhase.set('connecting')
      const providers = await fetchAuthProviders(base)
      const choice = chooseGatedAuth(providers, Boolean(input.username && input.password))

      if (choice.authMode === 'ticket') {
        if (!input.username || !input.password) {
          throw new Error('This backend requires a username and password')
        }

        // password-login sets the session cookie in Rust; the WS authorizes with
        // a per-connect ?ticket= (built in connectGateway).
        await passwordLogin(base, input.username, input.password, choice.provider)
        conn = { baseUrl: base, mode: 'remote', authMode: 'ticket' }
      } else {
        oauthProvider = choice.provider
        // Reuse a still-live session (e.g. a restored cookie jar, R2b) rather than
        // forcing an interactive sign-in; only open the webview when signed out.
        const live = await oauthStatus(base).catch(() => ({ signedIn: false }))

        if (!live.signedIn) {
          // On mobile this navigates the app away and never returns here — the reload
          // resumes via the pending marker (see beginOAuthLogin / autoRestoreConnection).
          await beginOAuthLogin(base, oauthProvider, input.username)
        }

        conn = { baseUrl: base, mode: 'remote', authMode: 'oauth' }
      }
    } else if (input.token && input.token.trim()) {
      conn = { baseUrl: base, mode: 'remote', authMode: 'token', token: input.token.trim() }
    } else {
      conn = { baseUrl: base, mode: 'remote', authMode: 'none' }
    }

    // ONE notification: the descriptor, its profile and its identity land
    // together, so nothing can fire REST at the new base under the old source's
    // scope while this awaits (store/active-connection.ts).
    publishActiveConnection(describeConnection(conn, hint))
    $connectionPhase.set('connecting')

    try {
      await connectGateway(conn)
    } catch (err) {
      // An OAuth session that expired between the status check and the ws-ticket
      // mint surfaces as GatewayReauthRequiredError — re-run sign-in once.
      if (conn.authMode === 'oauth' && isGatewayReauthRequired(err)) {
        await beginOAuthLogin(base, oauthProvider, input.username)
        await connectGateway(conn)
      } else {
        throw err
      }
    }

    $connectionPhase.set('ready')
    // Non-secret prefill in localStorage; secrets in the keyring (best-effort —
    // if the keyring is unavailable, secrets simply aren't persisted).
    saveString(URL_KEY, input.url.trim())
    saveString(USER_KEY, input.username ?? '')
    await saveSecrets({ token: input.token?.trim() || undefined, password: input.password || undefined })
    // Persist the session cookie jar (R2b) so a cookie-backed login (ticket now,
    // oauth/cloud once D6/E land) survives an app restart. No-op in token/none mode.
    await persistSessionCookies()
    // Remember this target so the next launch auto-reconnects (D8).
    saveGatewayTarget({
      connectionId: activeConnectionId(),
      mode: 'remote',
      url: input.url.trim(),
      username: input.username || undefined
    })
  } catch (err) {
    $connectionError.set(errorText(err))
    $connectionPhase.set('error')
    publishActiveConnection(null)
    throw err
  }
}

/**
 * Local mode (E3.b, desktop-only): spawn a bundled backend and connect to it in
 * token mode. The Rust command resolves only once the backend is HTTP-ready.
 */
export async function connectLocal(profile?: null | string): Promise<void> {
  const hint = takePendingConnectionHint()

  armReconnect()
  $connectionError.set(null)
  $connectionPhase.set('connecting')

  try {
    const backend = await spawnLocalBackend(profile)

    const conn: Connection = {
      baseUrl: backend.baseUrl,
      mode: 'local',
      authMode: 'token',
      token: backend.token,
      profile: profile ?? null
    }

    publishActiveConnection(describeConnection(conn, hint))
    await connectGateway(conn)
    $connectionPhase.set('ready')
    // Remember this target so the next launch auto-reconnects (D8).
    saveGatewayTarget({ connectionId: activeConnectionId(), mode: 'local', profile: profile ?? null })
  } catch (err) {
    // Tear the child down so a failed connect doesn't leave an orphan process.
    void stopLocalBackend().catch(() => {})
    $connectionError.set(errorText(err))
    $connectionPhase.set('error')
    publishActiveConnection(null)
    throw err
  }
}

/** The non-secret half of an SSH target, as the settings form collects it. */
export type SshTarget = Omit<
  SshConnectConfig,
  'privateKeyPem' | 'passphrase' | 'password' | 'installationId' | 'reuseToken' | 'interactive'
>

/**
 * SSH mode (MJX-55): reach a backend on a remote host through an SSH tunnel.
 *
 * Rust does the whole lifecycle and hands back a token-authed backend on
 * loopback, so from here this looks much more like `connectLocal` than like
 * `connect` — there is no /api/status probe and no auth negotiation, because the
 * tunnel already terminates at a backend we started ourselves.
 *
 * `onProgress` matters more than it looks: a cold connect spawns a process on
 * the remote and waits for it to bind, which can take 45–90s. Without it the UI
 * shows a motionless spinner for long enough to read as a hang.
 */
export async function connectSsh(
  target: SshTarget,
  options: { interactive?: boolean; attemptId?: string } = {}
): Promise<void> {
  armReconnect()
  $connectionError.set(null)
  $connectionPhase.set('connecting')

  const attemptId = options.attemptId ?? newAttemptId()
  const profile = target.profile ?? null
  // Taken BEFORE the long dial: a 90 s SSH connect must not have its identity
  // stolen by a second dial that started meanwhile.
  const hint = takePendingConnectionHint()
  // Tracked so `disconnect()` can abort a dial that is still running. A cold SSH
  // connect can take 90s, and without this the "Use a different gateway" escape
  // hatch only *looks* like it worked: the UI moves on while Rust keeps
  // spawning a backend on the remote.
  activeSshAttempt = attemptId

  // Publish progress for surfaces that never see the attempt id — the connecting
  // screen during a boot restore, and the tunnel re-bootstrap. Subscribed before
  // the invoke so no step is missed.
  const unlistenProgress = await onSshProgress(attemptId, progress => $sshStep.set(progress.step)).catch(() => null)

  try {
    // Secrets come from the keyring, never from the saved target.
    const [installationId, sshSecrets, saved] = await Promise.all([
      getInstallationId(),
      loadSshSecrets(),
      loadSavedLogin().catch(() => null)
    ])

    const backend = await connectSshBackend(attemptId, {
      ...target,
      profile,
      // Absent for the legacy owner, which is what collapses its ownership id to
      // the bare profile so a running remote backend is REATTACHED (§8.6).
      connectionId: hint?.dialConnectionId ?? undefined,
      installationId,
      privateKeyPem: sshSecrets.privateKeyPem,
      passphrase: sshSecrets.passphrase,
      password: sshSecrets.password,
      // The previous session token is what lets Rust REATTACH to a backend that
      // is already running remotely instead of spawning a second one.
      reuseToken: saved?.token || undefined,
      interactive: options.interactive ?? false
    })

    const conn: Connection = {
      baseUrl: backend.baseUrl,
      mode: 'ssh',
      authMode: 'token',
      token: backend.token,
      profile,
      remoteHost: backend.hostLabel,
      // Stable across re-tunnels, unlike baseUrl — see connectionCacheKey.
      remoteIdentity: backend.ownershipId
    }

    publishActiveConnection(describeConnection(conn, hint))
    await connectGateway(conn)
    $connectionPhase.set('ready')

    // Persist the token so the NEXT launch can reattach rather than respawn.
    //
    // ONLY for the legacy owner. A REGISTERED connection's reattach token is
    // written by Rust under its own account (`connections::remember_reuse_token`)
    // — the bare `SecretKey::Token` is shared with the remote gateway path, so
    // writing it here for every source is D-4: an ssh reattach token clobbering
    // a remote gateway's token and vice-versa.
    if (!hint?.dialConnectionId) {
      await saveSecrets({ token: backend.token })
    }

    saveGatewayTarget({ connectionId: activeConnectionId(), mode: 'ssh', profile, ssh: target })
    await watchSshTunnel(profile, hint?.dialConnectionId ?? null)
  } catch (err) {
    // Drop the tunnel so a failed connect does not leave one open. The remote
    // backend is deliberately left alone — Rust already reaped it if the failure
    // was its own.
    void disconnectSsh(profile, hint?.dialConnectionId ?? null).catch(() => {})
    $connectionError.set(errorText(err))
    $connectionPhase.set('error')
    publishActiveConnection(null)
    throw err
  } finally {
    unlistenProgress?.()
    $sshStep.set(null)

    if (activeSshAttempt === attemptId) {
      activeSshAttempt = null
    }
  }
}

/** The in-flight SSH dial, if any, so a deliberate disconnect can abort it. */
let activeSshAttempt: null | string = null

/**
 * Cloud mode (E5): connect to a portal-discovered agent's gateway. The agent
 * session cookie is already in the shared jar (portal_agent_sign_in ran first),
 * so this is an OAuth-style connect — the WS mints a ticket from that cookie.
 */
export async function connectCloud(baseUrl: string, profile?: null | string): Promise<void> {
  const hint = takePendingConnectionHint()

  armReconnect()
  $connectionError.set(null)
  $connectionPhase.set('connecting')

  try {
    const conn: Connection = {
      baseUrl: normalizeBaseUrl(baseUrl),
      mode: 'cloud',
      authMode: 'oauth',
      profile: profile ?? null
    }

    publishActiveConnection(describeConnection(conn, hint))

    try {
      await connectGateway(conn)
    } catch (err) {
      // An already-expired agent session surfaces as GatewayReauthRequiredError —
      // re-run the silent SSO once, mirroring connect()'s oauth retry.
      if (isGatewayReauthRequired(err)) {
        await portalAgentSignIn(conn.baseUrl)
        await connectGateway(conn)
      } else {
        throw err
      }
    }

    $connectionPhase.set('ready')
    await persistSessionCookies()
    // Remember this target so the next launch auto-reconnects (D8). connectCloudAgent
    // enriches it with the agent id/name afterwards (for the restore label).
    saveGatewayTarget({
      cloudBaseUrl: conn.baseUrl,
      connectionId: activeConnectionId(),
      mode: 'cloud',
      profile: profile ?? null
    })
  } catch (err) {
    $connectionError.set(errorText(err))
    $connectionPhase.set('error')
    publishActiveConnection(null)
    throw err
  }
}

export function disconnect(): void {
  // Mark this as a deliberate close so the reconnect supervisor stands down.
  intentionalClose = true
  // A deliberate disconnect ends the session: the root gate falls back to the
  // connect picker (not the reconnecting screen) next.
  $hasConnected.set(false)

  const conn = $connection.get()

  // If we were on a local-spawned backend, stop the child too.
  if (conn?.mode === 'local') {
    void stopLocalBackend().catch(() => {})
  }

  // For SSH this drops the TUNNEL only. The remote backend stays up on purpose
  // (it is detached) so the next connect reattaches instead of paying a full
  // spawn — matching desktop.
  if (conn?.mode === 'ssh') {
    stopWatchingSshTunnel()
    void disconnectSsh(conn.profile ?? null, $activeConnection.get()?.dialConnectionId ?? null).catch(() => {})
  }

  // Abort a dial that has not produced a connection yet — at this point there is
  // no `conn` to branch on, so this sits outside the check above.
  if (activeSshAttempt) {
    void cancelSsh(activeSshAttempt).catch(() => {})
    activeSshAttempt = null
  }

  closeGateway()
  publishActiveConnection(null)
  $connectionPhase.set('idle')
  $connectionError.set(null)
}

/**
 * Sign out: unlike disconnect() (which only drops the socket), this invalidates
 * the session — revokes the gateway OAuth cookie, clears the portal (Privy)
 * session for cloud, forgets stored secrets (incl. the persisted cookie jar),
 * then disconnects.
 */
export async function signOut(): Promise<void> {
  const conn = $connection.get()

  if (conn?.authMode === 'oauth') {
    await oauthLogout(conn.baseUrl).catch(() => {})
  }

  if (conn?.mode === 'cloud') {
    await portalLogout().catch(() => {})
  }

  await forgetSavedLogin().catch(() => {})
  disconnect()
}

// --------------------------------------------------------------------------
// SSH tunnel watchdog
// --------------------------------------------------------------------------
// The reconnect supervisor below re-opens the WEBSOCKET. That is enough for a
// dropped socket, but not for a dropped SSH SESSION: the baseUrl points at a
// local ephemeral port that only exists while the tunnel does, so once the
// session dies the supervisor re-dials a port nothing is listening on, backs off
// to 30s, and spins forever.
//
// Rust tells us when that happens. The fix is a full re-bootstrap rather than a
// re-dial — and because the remote backend was left running deliberately, that
// bootstrap hits the REUSE path (lockfile + /api/ssh/ownership proof) and
// reattaches in about two seconds instead of respawning.

let sshWatcher: null | (() => void) = null

async function watchSshTunnel(profile: null | string, connectionId: null | string): Promise<void> {
  sshWatcher?.()
  sshWatcher = null

  const unlisten = await onSshDisconnected(
    profile,
    () => {
      // A deliberate disconnect does not emit this, but the user may have torn the
      // connection down between the event firing and it arriving.
      if (intentionalClose || $connection.get()?.mode !== 'ssh') {
        return
      }

      void rebootstrapSsh()
    },
    connectionId
  ).catch(() => null)

  if (unlisten) {
    sshWatcher = unlisten
  }
}

/** Stop watching (a deliberate disconnect, or a switch to another mode). */
function stopWatchingSshTunnel(): void {
  sshWatcher?.()
  sshWatcher = null
}

let rebootstrapping = false

/**
 * Re-bootstrap the tunnel that died.
 *
 * Reads the LIVE connection rather than `loadGatewayTarget()`: the saved target
 * is whatever was persisted last, which after a source switch is a DIFFERENT
 * host — so the watchdog used to be able to re-dial the wrong machine (D-2). The
 * live descriptor is also what carries the registry identity, so a re-bootstrap
 * reattaches under the same ownership id instead of spawning a second backend.
 */
async function rebootstrapSsh(): Promise<void> {
  if (rebootstrapping) {
    return
  }

  rebootstrapping = true

  try {
    const active = $activeConnection.get()

    // The watchdog stands down for a latched source too — otherwise the latch
    // only stops one of the two retry paths and the loop continues through this
    // one instead.
    if (isLatched(active?.connectionId ?? null)) {
      return
    }

    const target = loadGatewayTarget()
    const ssh = target?.ssh

    if (!ssh?.host || (active && active.connection.mode !== 'ssh')) {
      return
    }

    const profile = active?.connection.profile ?? target?.profile ?? null

    if (active) {
      // Re-arm the identity for the dial that is about to publish.
      setPendingConnectionHint({
        connectionId: active.connectionId,
        dialConnectionId: active.dialConnectionId,
        label: active.label
      })
    }

    // Non-interactive: this fires on its own schedule, with no user waiting on a
    // dialog. Keyring-held credentials are all it gets.
    await connectSsh({ ...ssh, profile }, { interactive: false })
  } catch {
    // connectSsh already set $connectionError + phase; the connecting screen
    // surfaces it and the ordinary supervisor keeps retrying the socket.
  } finally {
    rebootstrapping = false
  }
}

// --------------------------------------------------------------------------
// Auto-reconnect supervisor (D7)
// --------------------------------------------------------------------------
// The vendored client has no reconnect logic, so a dropped socket (sleep/wake,
// network blip, expired session) leaves the app 'closed'. This watches
// $gatewayState and, on an UNEXPECTED close, re-dials with FULL-JITTER capped
// backoff (lib/reconnect-backoff): connectGateway re-mints a FRESH ws-ticket
// each attempt, and on an expired OAuth session it re-drives sign-in first.
// Guards against re-dialling a user-initiated disconnect and against re-entrant
// loops (the close a reconnect itself triggers).
//
// Jitter matters because a gateway restart drops every app pointed at it in the
// same instant; a deterministic ladder then has them all redial in the same
// instant too, which can exhaust the gateway's descriptors while it is still
// coming back up.
//
// FIXME(D7): reconnect re-opens the socket; it does not respawn a local backend
// whose process actually died, nor replay an interrupted streaming turn.

let intentionalClose = false
let reconnecting = false
let switching = false

/** Allow auto-reconnect after a fresh (re)connect attempt. */
function armReconnect(): void {
  intentionalClose = false
}

/**
 * A soft gateway switch is starting (store/gateway-switch.ts): stand the reconnect
 * supervisor down so it doesn't race the deliberate re-dial. Lives here rather than
 * reading `$gatewaySwitching` because connection.ts must not import gateway-switch.ts
 * (that store already imports this one — the seam keeps the store graph acyclic).
 *
 * Two flags are needed: `intentionalClose` covers the teardown, but every connect*()
 * calls armReconnect() at the top of the dial, so only `switching` keeps the ladder
 * down through the NEW gateway's handshake.
 */
export function beginGatewaySwitch(): void {
  switching = true
  intentionalClose = true
}

/** The switch finished (or failed): re-arm the supervisor against the new connection. */
export function endGatewaySwitch(): void {
  switching = false
}

/**
 * Once the loop has been failing continuously for this long, publish the last
 * failure on `$connectionError`. That is what reveals the embedded gateway
 * configurator on the connecting screen (see gateway-connecting-screen.tsx), so
 * a gateway that never comes back stops being a spinner with no way out.
 *
 * Time-based rather than attempt-count-based, because full jitter makes attempt
 * counts a meaningless clock: six jittered attempts can elapse in ~9s, while
 * the old deterministic 1→30s ladder took ~45s to reach six failures. 45s keeps
 * that original calibration (matching desktop's RECONNECT_ESCALATE_AFTER_MS).
 */
const RECONNECT_ESCALATE_AFTER_MS = 45_000

const reconnectDelay = (attempt: number): number => reconnectBackoffDelayMs(attempt)
const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

// DESKTOP ONLY — see the reauth branch in the loop for why mobile must never reach here.
//
// Unreachable for `ssh`: that mode is always authMode 'token', and the loop only
// calls this on a GatewayReauthRequiredError, which the ticket/oauth paths raise.
// A dropped SSH TUNNEL is a different failure and is not handled here — see the
// FIXME above.
async function reauthForReconnect(conn: Connection): Promise<void> {
  if (conn.mode === 'cloud') {
    await portalAgentSignIn(conn.baseUrl)
  } else {
    // Opens a dedicated sign-in window beside the app and resolves when the session
    // lands, so the dial below can simply continue.
    await beginOAuthLogin(conn.baseUrl)
  }
}

async function runReconnectLoop(): Promise<void> {
  reconnecting = true
  let attempt = 0
  // Wall-clock start of this disconnect episode (the first FAILED reconnect),
  // null while we have not failed yet. Drives the escalation below. Episode-
  // scoped by construction: the loop is re-entered fresh per episode.
  let failingSince: null | number = null

  while (!intentionalClose && !switching) {
    const conn = $connection.get()

    if (!conn) {
      break
    }

    await wait(reconnectDelay(attempt))

    if (intentionalClose || switching || !$connection.get()) {
      break
    }

    $connectionPhase.set('connecting')

    try {
      // For ssh, re-dialling the socket is pointless if the tunnel is what died —
      // the port is gone with it. Re-bootstrap instead; it reattaches to the
      // still-running remote backend through the reuse path.
      if (conn.mode === 'ssh') {
        await rebootstrapSsh()

        if ($connectionPhase.get() === 'ready') {
          break
        }

        throw new Error('SSH re-bootstrap did not reach a live connection')
      }

      await connectGateway(conn)

      if (intentionalClose || switching || !$connection.get()) {
        closeGateway()

        break
      }

      $connectionError.set(null)
      $connectionPhase.set('ready')

      break
    } catch (err) {
      // A failure that cannot self-heal is LATCHED, per connection, and the loop
      // stands down for that source (P-23). Nothing latched before this: the
      // loop re-entered on every `'closed'` and backed off forever, which is how
      // desktop's bundle showed 157 boot retries in 2.5 hours against a
      // reinstalled VPS. A transient fault is deliberately NOT latched.
      const latched = latchBackendFailure($activeConnection.get()?.connectionId ?? conn.baseUrl, {
        attemptedRemote: conn.mode !== 'local',
        error: err,
        isReauth: conn.authMode === 'oauth' && isGatewayReauthRequired(err)
      })

      if (latched === 'host-key-changed') {
        // Terminal by construction (`ssh/known_hosts.rs` calls it "always
        // fatal"): retrying cannot succeed until someone verifies the new key.
        $connectionError.set(errorText(err))

        break
      }

      if (conn.authMode === 'oauth' && isGatewayReauthRequired(err)) {
        // On mobile an interactive sign-in is a ONE-WAY DOOR: it navigates the app's only
        // webview to the login page and never returns (see `beginOAuthLogin`). This loop
        // is a BACKGROUND actor — it wakes on any dropped socket, with no user intent — so
        // walking through that door hijacks the whole app at an arbitrary moment, most
        // cruelly right as the user brings it back from the background.
        //
        // Worse, it does not hold the webview against anyone else. A user tapping Sign in
        // on the connect screen starts a second flow, which reads `webview.url()` AFTER
        // this one has already navigated and so captures the LOGIN PAGE as its "return
        // here afterwards" target. Whichever finishes last then restores the app to the
        // login page, and there is no way home. That is a real crash-and-strand seen on
        // device, not a theoretical race.
        //
        // So: report it and stand down. The user gets one deliberate, foreground sign-in.
        // `$connectionError` is what reveals the embedded configurator on the connecting
        // screen (gateway-connecting-screen.tsx), and `mintWsTicket` has already phrased
        // this for a human — "Session expired — sign in again".
        //
        // Published immediately rather than after RECONNECT_ESCALATE_AFTER_MS: that window
        // exists to let a transient failure resolve itself, and a refused credential is not
        // transient. Nothing is gained by making the user watch a spinner for 45s first.
        //
        // Two carve-outs, both because the door is not one-way for them:
        //   * DESKTOP opens a dedicated sign-in window beside the app and resolves, so the
        //     supervisor can re-auth without the user ever knowing.
        //   * CLOUD re-auths through `portalAgentSignIn`, which on mobile is the silent
        //     reqwest cascade (`cloud.rs::agent_sso`) — nothing navigates, so it is safe to
        //     drive from the background and blocking it would be a pointless regression.
        if (IS_NATIVE_MOBILE && conn.mode !== 'cloud') {
          $connectionError.set(errorText(err))

          break
        }

        try {
          await reauthForReconnect(conn)
          await connectGateway(conn)
          $connectionError.set(null)
          $connectionPhase.set('ready')

          break
        } catch {
          // fall through to backoff
        }
      }

      if (failingSince === null) {
        failingSince = Date.now()
      }

      // Past the escalation window, stop swallowing the failure: publishing it
      // reveals the configurator on the connecting screen, so a gateway that is
      // never coming back has a way out instead of an endless spinner. The last
      // error is used verbatim — it says WHY, which a generic string cannot.
      if (Date.now() - failingSince >= RECONNECT_ESCALATE_AFTER_MS) {
        $connectionError.set(errorText(err))
      }

      attempt++
    }
  }

  reconnecting = false
}

$gatewayState.subscribe(state => {
  if (state === 'closed' && !intentionalClose && !switching && !reconnecting && $connection.get()) {
    void runReconnectLoop()
  }
})

// Latch "has connected this session" on every ready transition (initial connect,
// local/cloud connect, and each successful auto-reconnect). One place covers them
// all; `disconnect()` clears it.
$connectionPhase.subscribe(phase => {
  if (phase === 'ready') {
    $hasConnected.set(true)

    // A source that just connected is, by definition, no longer held down.
    const connectionId = $activeConnection.get()?.connectionId

    if (connectionId) {
      releaseLatch(connectionId)
    }
  }
})
