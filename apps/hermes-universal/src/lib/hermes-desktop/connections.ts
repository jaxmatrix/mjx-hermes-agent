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
 * another connection, or a window opened on a profile of its own.
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
import { withSocketProfile } from '@/transport/gateway-profile'
import { type GatewayMint, recordGatewayMint } from '@/transport/gateway-socket'

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
 * `wsUrl` as `profile`'s socket dials it. The launch profile's is as minted: an
 * RPC naming no profile is already its own. Recorded again, because the ledger
 * is keyed by URL.
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

  recordGatewayMint(wsUrl, dial.mint)

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

    // Only an Error is this app's own words.
    return { error: error instanceof Error ? error.message : MINT_FAILED, ok: false }
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

async function windowProfile(): Promise<null | string> {
  // Dynamic: `store/windows.ts` imports the route tree.
  const { windowProfileOverride } = await import('@/store/windows')

  return windowProfileOverride()
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

/**
 * The same two facts, for REST. Desktop names the owning connection on every
 * call, the primary's included, while `lib/api.ts` reads a `connectionId` as a
 * gateway OTHER than the active one and finds a tunnelled one only through a
 * lease this window holds. So the primary's id is dropped — the call takes the
 * active path, `$connection`'s base, which needs no lease — and another local or
 * SSH connection is held for the length of the call (`tunnelDial`'s rule: the
 * slot lingers, so the next call finds it warm).
 */
export async function restScope(
  connectionId: null | string | undefined
): Promise<{ connectionId?: string; release: () => void }> {
  const id = (connectionId ?? '').trim()

  if (!id || id === (await activeConnection())?.connectionId) {
    return { release: () => {} }
  }

  // Dynamic: the registry store imports `@/hermes`.
  const { connectionById } = await import('@/store/connections')
  const row = connectionById(id)

  if (!row || row.url || (row.kind !== 'local' && row.kind !== 'ssh')) {
    return { connectionId: id, release: () => {} }
  }

  const { acquireTunnel } = await import('@/store/connection-tunnels')

  const lease = await acquireTunnel(id, { label: row.label }).catch(error => {
    throw tunnelFailure(error)
  })

  return { connectionId: id, release: () => lease.release() }
}

export const connectionBridge: Pick<
  Bridge,
  'getBootProgress' | 'getConnection' | 'getGatewayWsUrl' | 'onBackendExit' | 'onBootProgress' | 'onPowerResume'
> &
  Required<Pick<Bridge, 'getConnectionFor' | 'getGatewayWsUrlFor'>> & { profile: Pick<Bridge['profile'], 'get'> } = {
  getBootProgress: async () => boot,

  getConnection: async profile => {
    const dial = await primaryDial()
    // Naming none asks for this window's own primary (the boot hook's wake
    // reconnect): the profile it was opened on, when it was opened on one.
    const key = profileKey(profile?.trim() || (await windowProfile()))

    return descriptor(dial, key, key === LAUNCH_PROFILE ? {} : { profile: key, sharedPrimary: true })
  },

  getConnectionFor: async ({ connectionId, profile }) => {
    const key = profileKey(profile)

    return descriptor(await dialFor(connectionId), key, { profile: key, registryScoped: true, sharedRemote: true })
  },

  getGatewayWsUrl: profile => wsUrlResult(primaryDial(), profileKey(profile)),

  getGatewayWsUrlFor: ({ connectionId, profile }) => wsUrlResult(dialFor(connectionId), profileKey(profile)),

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
