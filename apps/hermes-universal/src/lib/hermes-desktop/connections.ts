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
 * No descriptor carries a token. A URL a gateway may dial is recorded with
 * `recordGatewayMint`, and Rust attaches the credential on `ws_open`.
 */

import type { GatewayWsUrlResult } from '@hermes/shared'
import { invoke } from '@tauri-apps/api/core'

import { tunnelErrorMessage } from '@/app/gateway/ssh-copy'
import { isGatewayReauthRequired } from '@/gateway'
import type { DesktopBootProgress, HermesConnection } from '@/global'
import { TRANSLATIONS } from '@/i18n/catalog'
import { getRuntimeI18nLocale } from '@/i18n/runtime'
import { errorText } from '@/lib/error-text'
import { IS_MOBILE } from '@/lib/platform'
import { onForeground } from '@/store/app-lifecycle'
import { type Connection, type GatewayMode, resolveWsUrl, ticketMintDeps } from '@/store/gateway-config'
import { recordGatewayMint } from '@/transport/gateway-socket'

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
  remoteHost?: string
  /** Recorded, and ticketless: what an ungated or token connection dials. */
  wsUrl: string
}

/** A primary dial failure the boot hook may retry on its own (#82679). */
class RetryableDialError extends Error {}

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
    const wsUrl = lease.wsUrl()

    recordGatewayMint(wsUrl, { connectionId, label: row.label, tunnel: true })

    return { baseUrl: lease.baseUrl(), connectionId, gated: false, kind: row.kind, remoteHost: row.remoteHost, wsUrl }
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

  recordGatewayMint(wsUrl, { connectionId })

  return { baseUrl: live.baseUrl, connectionId, gated, kind: live.mode ?? 'remote', remoteHost: live.remoteHost, wsUrl }
}

async function resolveDial(connectionId: string, live?: Connection): Promise<Dial> {
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

  const wsUrl = await resolveWsUrl({ authMode: 'none', baseUrl: row.baseUrl })

  recordGatewayMint(wsUrl, { connectionId })

  return {
    baseUrl: row.baseUrl,
    connectionId,
    // The live probe knows a gateway became gated before the saved row does.
    gated: isGated(row.authMode) || isGated(live?.authMode),
    kind: row.kind,
    remoteHost: row.remoteHost,
    wsUrl
  }
}

/** The URL to dial NOW: a gated connection's ticket is single-use. */
async function freshWsUrl(dial: Dial): Promise<string> {
  if (!dial.gated) {
    return dial.wsUrl
  }

  // Minted directly: `resolveGatewayWsUrl` would wrap a transport rejection — a
  // bare string that can name the host — into an Error like any other.
  const wsUrl = await ticketMintDeps(dial.baseUrl).getGatewayWsUrl()

  recordGatewayMint(wsUrl, { connectionId: dial.connectionId })

  return wsUrl
}

/** Electron's `gatewayWsUrlIpcResult`: a mint never rejects, it answers. */
async function wsUrlResult(dial: Promise<Dial>): Promise<GatewayWsUrlResult> {
  try {
    return { ok: true, wsUrl: await freshWsUrl(await dial) }
  } catch (error) {
    if (isGatewayReauthRequired(error)) {
      return { error: SIGN_IN_REQUIRED, needsOauthLogin: true, ok: false }
    }

    // Only an Error is this app's own words.
    return { error: error instanceof Error ? error.message : MINT_FAILED, ok: false }
  }
}

function descriptor(dial: Dial, scope: Partial<HermesConnection> = {}): HermesConnection {
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
    wsUrl: dial.wsUrl,
    ...scope
  }
}

function bootProgress(update: Pick<DesktopBootProgress, 'message' | 'phase' | 'progress' | 'running'>, error?: Error) {
  return {
    ...update,
    error: error?.message ?? null,
    fakeMode: false,
    retryable: error instanceof RetryableDialError,
    timestamp: Date.now()
  }
}

/**
 * Nothing is spawned on the boot hook's behalf — `store/connection.ts` brings
 * the backend up — so there is no progress to push. The snapshot is what the
 * last primary dial found, which is where the hook reads `retryable`.
 */
let boot: DesktopBootProgress = bootProgress({
  message: 'Waiting for a Hermes backend',
  phase: 'idle',
  progress: 0,
  running: false
})

async function activeConnection() {
  // Dynamic: `store/active-connection.ts` imports `@/hermes`.
  const { $activeConnection } = await import('@/store/active-connection')

  return $activeConnection.get()
}

async function primaryDial(): Promise<Dial> {
  try {
    const active = await activeConnection()

    if (!active) {
      throw new Error('Not connected to a Hermes backend')
    }

    const dial = await resolveDial(active.connectionId, active.connection)

    boot = bootProgress({ message: 'Hermes backend is ready', phase: 'backend.ready', progress: 94, running: true })

    return dial
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(errorText(error))

    boot = bootProgress({ message: failure.message, phase: 'backend.error', progress: 0, running: false }, failure)

    throw failure
  }
}

/** An empty id, or the primary's own, is the primary (Electron's `|| registry.primary`). */
async function dialFor(connectionId: null | string | undefined): Promise<Dial> {
  const id = (connectionId ?? '').trim()

  return !id || id === (await activeConnection())?.connectionId ? primaryDial() : resolveDial(id)
}

export const connectionBridge: Pick<
  Bridge,
  'getBootProgress' | 'getConnection' | 'getGatewayWsUrl' | 'onBackendExit' | 'onBootProgress' | 'onPowerResume'
> &
  Required<Pick<Bridge, 'getConnectionFor' | 'getGatewayWsUrlFor'>> & { profile: Pick<Bridge['profile'], 'get'> } = {
  getBootProgress: async () => boot,

  getConnection: async profile => {
    const dial = await primaryDial()
    const key = profileKey(profile)

    return descriptor(dial, key === LAUNCH_PROFILE ? {} : { profile: key, sharedPrimary: true })
  },

  getConnectionFor: async ({ connectionId, profile }) =>
    descriptor(await dialFor(connectionId), { profile: profileKey(profile), registryScoped: true, sharedRemote: true }),

  getGatewayWsUrl: () => wsUrlResult(primaryDial()),

  getGatewayWsUrlFor: ({ connectionId }) => wsUrlResult(dialFor(connectionId)),

  // No exit signal exists: a local child that dies is a closed socket and a
  // tunnel status, both already handled where they land.
  onBackendExit: () => () => {},

  onBootProgress: () => () => {},

  // A phone's socket always dies while the app is away (`store/app-lifecycle.ts`),
  // so coming back IS a resume. A desktop window merely becoming visible is not,
  // and a resume force-closes every open secondary.
  ...(IS_MOBILE && { onPowerResume: (callback: () => void) => onForeground(callback) }),

  profile: { get: async () => ({ profile: LAUNCH_PROFILE }) }
}
