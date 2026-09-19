/**
 * The bridge's connection half: what desktop's gateway registry
 * (`store/gateway.ts`) and boot hook (`app/gateway/hooks/use-gateway-boot.ts`)
 * ask Electron's main process for, answered from the Rust connection registry
 * (`connections_resolve`) and its tunnels (`store/connection-tunnels.ts`).
 *
 * Two facts shape every answer:
 *
 *  • The PRIMARY is the connection this window is on (`$activeConnection`) —
 *    what `selectConnection` re-homes, as a Settings apply re-homes desktop's.
 *  • Every backend here is the unified server: one socket per connection, the
 *    profile named per RPC. So another profile of the primary is a request
 *    scope on the primary socket (`sharedPrimary` / `sharedRemote`), never a
 *    second dial, and the launch profile is `default` — what `local_backend.rs`
 *    and the SSH bootstrap both spawn.
 *
 * The socket itself has no profile, so a URL minted for any other profile says
 * so (`withSocketProfile`) and `HermesGateway` names it per RPC: a secondary on
 * another connection, a window opened on a profile of its own, or a primary
 * whose identity names another profile (`primaryProfile`).
 *
 * No descriptor carries a token. A URL a gateway may dial is recorded with
 * `recordGatewayMint`, and Rust attaches the credential on `ws_open`.
 */

import type { GatewayWsUrlResult } from '@hermes/shared'
import { invoke } from '@tauri-apps/api/core'

import { sshStepLabel, tunnelErrorMessage } from '@/app/gateway/ssh-copy'
import { isGatewayReauthRequired } from '@/gateway'
import type { DesktopBootProgress, HermesConnection } from '@/global'
import { TRANSLATIONS } from '@/i18n/catalog'
import { getRuntimeI18nLocale } from '@/i18n/runtime'
import { errorText, ownWords } from '@/lib/error-text'
import { IS_MOBILE } from '@/lib/platform'
import { sessionCookiesRestored } from '@/lib/session-persist'
import type { ActiveConnection } from '@/store/active-connection'
import { onForeground } from '@/store/app-lifecycle'
import type { TunnelStatus } from '@/store/connection-tunnels'
import { type Connection, type GatewayMode, resolveWsUrl, ticketMintDeps } from '@/store/gateway-config'
import { withSocketProfile } from '@/transport/gateway-profile'
import { type GatewayMint, recordGatewayMint } from '@/transport/gateway-socket'

import { onConnectionApplied } from './connection-applied'

type Bridge = NonNullable<typeof window.hermesDesktop>

const LAUNCH_PROFILE = 'default'

const SIGN_IN_REQUIRED = 'Session expired — sign in again'
const MINT_FAILED = 'Could not refresh the gateway WebSocket ticket'

/** The slice of `connections_resolve`'s `ResolvedDial` a dial needs. */
interface ResolvedRow {
  authMode?: 'none' | 'oauth' | 'token'
  baseUrl?: string
  kind: GatewayMode
  label: string
  remoteHost?: string
}

interface Dial {
  baseUrl: string
  connectionId: string
  /** The handshake needs a fresh single-use ticket (OAuth or password login). */
  gated: boolean
  kind: GatewayMode
  /** What every URL of this dial is recorded as. */
  mint: GatewayMint
  remoteHost?: string
  /** Recorded, and ticketless: what an ungated or token connection dials. */
  wsUrl: string
}

/** A primary dial failure the boot hook may retry on its own (#82679). */
class RetryableDialError extends Error {}

/**
 * The boot cookie restore is still behind the OS unlock prompt
 * (`secure-store.ts` → `secrets_unlock`, which no platform but Apple's bounds).
 * A locked keyring a person must open is legitimate; a dial that says nothing
 * while it waits is not. Not retryable: a retry cannot answer the prompt, and
 * the hook's Retry is what a person presses once they have.
 */
export class NeedsUnlockError extends Error {
  override name = 'NeedsUnlockError'
}

/** Under the hook's 45 s boot budget (`BACKEND_BOOT_WAIT_TIMEOUT_MS`), so what a
 *  person reads is why, not "timed out". */
const COOKIE_RESTORE_WAIT_MS = 30_000

/**
 * The boot cookie restore, waited on for a bounded time. The restore itself is
 * never abandoned: it lands when the person unlocks, and every later call
 * proceeds at once.
 */
async function cookieJarRestored(): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined

  const waited = new Promise<'waiting'>(resolve => {
    timer = setTimeout(() => resolve('waiting'), COOKIE_RESTORE_WAIT_MS)
  })

  try {
    if ((await Promise.race([sessionCookiesRestored(), waited])) === 'waiting') {
      throw new NeedsUnlockError(TRANSLATIONS[getRuntimeI18nLocale()].boot.errors.needsUnlock)
    }
  } finally {
    clearTimeout(timer)
  }
}

function profileKey(profile: null | string | undefined): string {
  return (profile ?? '').trim() || LAUNCH_PROFILE
}

function isGated(authMode: string | undefined): boolean {
  return authMode === 'oauth' || authMode === 'ticket'
}

/**
 * A tunnel failure as copy. Rust's own message can name the host, and the
 * sign-in or host-key notification has already been raised by `acquireTunnel`.
 */
function tunnelFailure(error: unknown): Error {
  const message = tunnelErrorMessage(error, TRANSLATIONS[getRuntimeI18nLocale()].settings.gateway)

  return (error as { terminal?: unknown } | null)?.terminal === false
    ? new RetryableDialError(message)
    : new Error(message)
}

/**
 * Local and SSH: reached through a tunnel. Acquired HERE, so a cold SSH dial
 * (45–90 s) is spent on the descriptor's budget rather than the client's 15 s
 * connect timeout, and let go at once: Rust keeps an unheld slot `LINGER_MS`
 * (`tunnels.rs`), so the socket's own acquire finds it warm.
 */
async function tunnelDial(connectionId: string, row: ResolvedRow): Promise<Dial> {
  // Dynamic: the tunnel store reaches `@/hermes`, and this module is part of
  // the bridge `main.tsx` installs before anything else.
  const { acquireTunnel } = await import('@/store/connection-tunnels')

  const lease = await acquireTunnel(connectionId, { label: row.label }).catch(error => {
    throw tunnelFailure(error)
  })

  try {
    const mint = { connectionId, label: row.label, tunnel: true }
    const wsUrl = lease.wsUrl()

    recordGatewayMint(wsUrl, mint)

    return {
      baseUrl: lease.baseUrl(),
      connectionId,
      gated: false,
      kind: row.kind,
      mint,
      remoteHost: row.remoteHost,
      wsUrl
    }
  } finally {
    lease.release()
  }
}

/**
 * The primary before the registry has a row for it: the boot restore dials
 * ahead of `connections_migrate`. The live descriptor is all there is, and its
 * URL carries whatever auth it has, as `store/gateway-client.ts` dials today.
 */
async function liveDial(connectionId: string, live: Connection): Promise<Dial> {
  const gated = isGated(live.authMode)
  const wsUrl = await resolveWsUrl(gated ? { ...live, authMode: 'none' } : live)

  const mint = { connectionId }

  recordGatewayMint(wsUrl, mint)

  return {
    baseUrl: live.baseUrl,
    connectionId,
    gated,
    kind: live.mode ?? 'remote',
    mint,
    remoteHost: live.remoteHost,
    wsUrl
  }
}

async function resolveDial(connectionId: string, live?: Connection): Promise<Dial> {
  // The boot hook's first dial races the cookie restore `boot.ts` started.
  await cookieJarRestored()

  let row: ResolvedRow

  try {
    row = await invoke<ResolvedRow>('connections_resolve', { connectionId, profile: null })
  } catch (error) {
    if (live) {
      return liveDial(connectionId, live)
    }

    // The text `store/gateway.ts` fail-stops a removed connection on.
    throw new Error(
      (error as { kind?: unknown } | null)?.kind === 'not-found'
        ? `No connection with id "${connectionId}"`
        : errorText(error)
    )
  }

  if (!row.baseUrl) {
    if (row.kind === 'local' || row.kind === 'ssh') {
      return tunnelDial(connectionId, row)
    }

    throw new Error('This connection has no gateway address')
  }

  const mint = { connectionId }
  const wsUrl = await resolveWsUrl({ authMode: 'none', baseUrl: row.baseUrl })

  recordGatewayMint(wsUrl, mint)

  return {
    baseUrl: row.baseUrl,
    connectionId,
    // The live probe knows a gateway became gated before the saved row does.
    gated: isGated(row.authMode) || isGated(live?.authMode),
    kind: row.kind,
    mint,
    remoteHost: row.remoteHost,
    wsUrl
  }
}

/**
 * `wsUrl` as `profile`'s socket dials it, recorded: the ledger is keyed by URL,
 * and this is the one a gateway dials. The launch profile's is as minted — an
 * RPC naming no profile is already its own — and `resolveDial` recorded that.
 */
function profileWsUrl(dial: Dial, wsUrl: string, profile: string): string {
  if (profile === LAUNCH_PROFILE) {
    return wsUrl
  }

  const scoped = withSocketProfile(wsUrl, profile)

  recordGatewayMint(scoped, dial.mint)

  return scoped
}

/** The URL to dial NOW: a gated connection's ticket is single-use. */
async function freshWsUrl(dial: Dial, profile: string): Promise<string> {
  if (!dial.gated) {
    return profileWsUrl(dial, dial.wsUrl, profile)
  }

  // Minted directly: `resolveGatewayWsUrl` would wrap a transport rejection — a
  // bare string that can name the host — into an Error like any other.
  const wsUrl = await ticketMintDeps(dial.baseUrl).getGatewayWsUrl()

  // ONE entry, under the URL that is dialled: the bare ticketed URL is only
  // dialled as the launch profile's.
  if (profile === LAUNCH_PROFILE) {
    recordGatewayMint(wsUrl, dial.mint)
  }

  return profileWsUrl(dial, wsUrl, profile)
}

/** Electron's `gatewayWsUrlIpcResult`: a mint never rejects, it answers. */
async function wsUrlResult(dial: Promise<Dial>, profile: string): Promise<GatewayWsUrlResult> {
  try {
    return { ok: true, wsUrl: await freshWsUrl(await dial, profile) }
  } catch (error) {
    if (isGatewayReauthRequired(error)) {
      return { error: SIGN_IN_REQUIRED, needsOauthLogin: true, ok: false }
    }

    return { error: ownWords(error, MINT_FAILED).message, ok: false }
  }
}

function descriptor(dial: Dial, profile: string, scope: Partial<HermesConnection> = {}): HermesConnection {
  return {
    authMode: dial.gated ? 'oauth' : 'token',
    baseUrl: dial.baseUrl,
    connectionId: dial.connectionId,
    isFullscreen: false,
    logs: [],
    mode: dial.kind === 'local' ? 'local' : 'remote',
    nativeOverlayWidth: 0,
    ...(dial.kind !== 'local' && { remoteKind: dial.kind === 'remote' ? 'url' : dial.kind }),
    ...(dial.remoteHost && { remoteHost: dial.remoteHost }),
    token: '',
    windowButtonPosition: null,
    wsUrl: profileWsUrl(dial, dial.wsUrl, profile),
    ...scope
  }
}

function bootProgress(
  update: Pick<DesktopBootProgress, 'message' | 'phase' | 'progress' | 'running'>,
  failure?: { message: string; retryable: boolean }
): DesktopBootProgress {
  return {
    ...update,
    error: failure?.message ?? null,
    fakeMode: false,
    retryable: failure?.retryable === true,
    timestamp: Date.now()
  }
}

const BACKEND_READY = { message: 'Hermes backend is ready', phase: 'backend.ready', progress: 94, running: true }

/** Where a tunnel dial's steps sit on the overlay: above the hook's own 6, below `backend.ready`. */
const DIAL_FLOOR = 4
const DIAL_SPAN = 90

/**
 * A tunnel status as Electron's boot progress: the one backend bring-up this
 * app has is the dial of a local or SSH connection. `terminal` is Rust's word
 * for "retrying cannot fix this", so a tunnel that needs a person — or one the
 * book refuses to dial in the background until someone acts — is a boot error
 * the hook must NOT retry; its sign-in or host-key notification is the way
 * out. Rust's own message can name the host, so the error is copy.
 */
export function tunnelBootProgress(status: TunnelStatus): DesktopBootProgress | null {
  const copy = TRANSLATIONS[getRuntimeI18nLocale()]

  if (status.phase === 'ready') {
    return bootProgress(BACKEND_READY)
  }

  if (status.phase === 'failed') {
    const message = tunnelErrorMessage({ kind: status.errorKind }, copy.settings.gateway)

    return bootProgress(
      { message, phase: 'backend.error', progress: 0, running: false },
      { message, retryable: !status.terminal }
    )
  }

  // A slot that left: whatever ended it has already been said.
  if (status.phase === 'closed') {
    return null
  }

  return bootProgress({
    message: status.step
      ? sshStepLabel(status.step, copy.settings.gateway)
      : status.phase === 'retrying'
        ? copy.boot.steps.retryingRemoteBackend
        : copy.boot.steps.startingDesktopConnection,
    phase: 'backend.resolve',
    progress: DIAL_FLOOR + Math.round((status.fraction ?? 0) * DIAL_SPAN),
    running: true
  })
}

/**
 * What the last primary dial found, or where the primary's tunnel is: the hook
 * reads `retryable` here after a failed boot, and paints the rest.
 */
let boot: DesktopBootProgress = bootProgress({
  message: 'Waiting for a Hermes backend',
  phase: 'idle',
  progress: 0,
  running: false
})

const bootListeners = new Set<(payload: DesktopBootProgress) => void>()

function publishBoot(next: DesktopBootProgress): void {
  boot = next

  for (const listener of [...bootListeners]) {
    listener(next)
  }
}

/** Follow the ACTIVE connection's tunnel for as long as someone listens. */
async function watchPrimaryTunnel(): Promise<() => void> {
  // Dynamic: both stores reach `@/hermes`.
  const [{ $tunnelStatus }, { $activeConnection }] = await Promise.all([
    import('@/store/connection-tunnels'),
    import('@/store/active-connection')
  ])

  let seen: TunnelStatus | undefined

  return $tunnelStatus.listen(all => {
    const connectionId = $activeConnection.get()?.connectionId
    const status = connectionId ? all[connectionId] : undefined

    if (!status || status === seen) {
      return
    }

    seen = status

    const next = tunnelBootProgress(status)

    if (next) {
      publishBoot(next)
    }
  })
}

let primaryTunnelWatch: null | Promise<() => void> = null

async function activeConnection() {
  // Dynamic: the bridge installs before the stores evaluate (`main.tsx`).
  const { $activeConnection, launchSettled } = await import('@/store/active-connection')

  // The boot hook's first ask races the launch identity `boot.ts` is publishing.
  await launchSettled()

  return $activeConnection.get()
}

async function windowProfile(): Promise<null | string> {
  // Dynamic: `store/windows.ts` imports the route tree.
  const { windowProfileOverride } = await import('@/store/windows')

  return windowProfileOverride()
}

/**
 * A tunnelled primary's base is a loopback port that exists only once dialled,
 * and moves on a redial. The identity is published without one at launch, and
 * REST on the active path reads `$connection`'s base, so it follows the dial.
 */
async function followTunnelBase(active: ActiveConnection, dial: Dial): Promise<void> {
  if (!dial.mint.tunnel || active.connection.baseUrl === dial.baseUrl) {
    return
  }

  // Dynamic: the bridge installs before the stores evaluate (`main.tsx`).
  const { $activeConnection, publishActiveConnection } = await import('@/store/active-connection')

  // Re-homed while the tunnel dialled: the base belongs to the one that left.
  if ($activeConnection.get() === active) {
    publishActiveConnection({ ...active, connection: { ...active.connection, baseUrl: dial.baseUrl } })
  }
}

/** Dial the primary `active` names — read ONCE by the caller, so the dial and
 *  the profile it is served under describe the same connection. */
async function primaryDial(active: ActiveConnection | null): Promise<Dial> {
  try {
    if (!active) {
      throw new Error('Not connected to a Hermes backend')
    }

    const dial = await resolveDial(active.connectionId, active.connection)

    await followTunnelBase(active, dial)

    publishBoot(bootProgress(BACKEND_READY))

    return dial
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(errorText(error))

    publishBoot(
      bootProgress(
        { message: failure.message, phase: 'backend.error', progress: 0, running: false },
        { message: failure.message, retryable: failure instanceof RetryableDialError }
      )
    )

    throw failure
  }
}

/**
 * The profile the primary socket serves: the window's own, else the one its
 * IDENTITY names — what Electron's `primaryProfilePin` holds. The registry files
 * the primary under the profile the hook adopted (`profile.get`) and sends that
 * profile's RPCs with no `profile`, so the socket has to be the one that names
 * it: the primary's URL carries the same profile the hook adopts.
 *
 * Derived nowhere else. The identity is built with the profile the connection
 * was last used on (`resolveConnection`, store/connections) and lives as long
 * as the primary does, so a profile remembered mid-life cannot re-scope a socket
 * the registry still files under the old one; a re-home publishes a new one.
 */
async function primaryProfile(active: ActiveConnection | null): Promise<string> {
  return active ? profileKey((await windowProfile()) ?? active.profile) : LAUNCH_PROFILE
}

/** An empty id, or the primary's own, is the primary (Electron's `|| registry.primary`). */
async function dialFor(connectionId: null | string | undefined): Promise<Dial> {
  const id = (connectionId ?? '').trim()
  const active = await activeConnection()

  return !id || id === active?.connectionId ? primaryDial(active) : resolveDial(id)
}

/**
 * The same two facts, for REST. Desktop names the owning connection on every
 * call, the primary's included, while `lib/api.ts` reads a `connectionId` as a
 * gateway OTHER than the active one and finds a tunnelled one only through a
 * lease this window holds. So the primary's id is dropped — the call takes the
 * active path, `$connection`'s base, which needs no lease — and another local or
 * SSH connection is held for the length of the call (`tunnelDial`'s rule: the
 * slot lingers, so the next call finds it warm). So is a tunnelled primary whose
 * base is not known yet: a launch publishes it undialled (`followTunnelBase`).
 */
export async function restScope(
  connectionId: null | string | undefined
): Promise<{ connectionId?: string; release: () => void }> {
  const id = (connectionId ?? '').trim()

  // A cookie-backed REST call needs the jar as much as a dial does.
  await cookieJarRestored()

  const active = await activeConnection()
  const primary = !id || id === active?.connectionId

  if (primary && (!active || active.connection.baseUrl)) {
    return { release: () => {} }
  }

  const target = primary && active ? active.connectionId : id

  // Dynamic: the registry store imports `@/hermes`.
  const { connectionById } = await import('@/store/connections')
  const row = connectionById(target)

  if (!row || row.url || (row.kind !== 'local' && row.kind !== 'ssh')) {
    return { connectionId: target, release: () => {} }
  }

  const { acquireTunnel } = await import('@/store/connection-tunnels')

  const lease = await acquireTunnel(target, { label: row.label }).catch(error => {
    throw tunnelFailure(error)
  })

  return { connectionId: target, release: () => lease.release() }
}

export const connectionBridge: Pick<
  Bridge,
  'getBootProgress' | 'getConnection' | 'getGatewayWsUrl' | 'onBackendExit' | 'onBootProgress' | 'onPowerResume'
> &
  Required<Pick<Bridge, 'getConnectionFor' | 'getGatewayWsUrlFor' | 'onConnectionApplied'>> & {
    profile: Pick<Bridge['profile'], 'get' | 'remember'>
  } = {
  getBootProgress: async () => boot,

  getConnection: async profile => {
    // Read once: a re-home between two reads is one connection's dial under
    // another's profile.
    const active = await activeConnection()
    const dial = await primaryDial(active)
    const own = await primaryProfile(active)
    // Naming none asks for this window's own primary (the boot hook's boot,
    // soft switch and wake reconnect).
    const key = profile?.trim() ? profileKey(profile) : own

    // Unscoped only where an unscoped RPC is right: the launch profile, on a
    // primary that serves it. On a primary that serves another, `default` is a
    // request scope like any other.
    return descriptor(
      dial,
      key,
      key === LAUNCH_PROFILE && own === LAUNCH_PROFILE ? {} : { profile: key, sharedPrimary: true }
    )
  },

  getConnectionFor: async ({ connectionId, profile }) => {
    const key = profileKey(profile)

    return descriptor(await dialFor(connectionId), key, { profile: key, registryScoped: true, sharedRemote: true })
  },

  getGatewayWsUrl: async profile => {
    const active = await activeConnection()
    const key = profile?.trim() ? profileKey(profile) : await primaryProfile(active)

    return wsUrlResult(primaryDial(active), key)
  },

  getGatewayWsUrlFor: ({ connectionId, profile }) => wsUrlResult(dialFor(connectionId), profileKey(profile)),

  // No exit signal exists: Rust emits nothing of its own when the local child
  // dies. It is a closed socket and a tunnel status, both already handled where
  // they land, so this subscribes and never fires.
  onBackendExit: () => () => {},

  onBootProgress: callback => {
    bootListeners.add(callback)

    if (!primaryTunnelWatch) {
      const watch = watchPrimaryTunnel()

      primaryTunnelWatch = watch
      // A failed start is forgotten, so the next listener starts the watch again.
      watch.catch(() => {
        if (primaryTunnelWatch === watch) {
          primaryTunnelWatch = null
        }
      })
    }

    return () => {
      bootListeners.delete(callback)

      if (!bootListeners.size && primaryTunnelWatch) {
        void primaryTunnelWatch.then(stop => stop()).catch(() => {})
        primaryTunnelWatch = null
      }
    }
  },

  onConnectionApplied,

  // A phone's socket always dies while the app is away (`store/app-lifecycle.ts`),
  // so coming back IS a resume. A desktop window merely becoming visible is not,
  // and a resume force-closes every open secondary.
  ...(IS_MOBILE && { onPowerResume: (callback: () => void) => onForeground(callback) }),

  profile: {
    get: async () => ({ profile: await primaryProfile(await activeConnection()) }),

    // Electron's one preference file is, here, the registry store's per-source
    // memory: the primary is whichever connection the window is on.
    remember: async name => {
      const connectionId = (await activeConnection())?.connectionId
      const profile = profileKey(name)

      if (connectionId) {
        // Dynamic: the registry store imports `@/hermes`.
        const { rememberProfile } = await import('@/store/connections')

        rememberProfile(connectionId, profile)
      }

      return { profile }
    }
  }
}
