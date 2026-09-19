import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

import { tunnelErrorMessage } from '@/app/gateway/ssh-copy'
import { translateNow } from '@/i18n'
import { TRANSLATIONS } from '@/i18n/catalog'
import { getRuntimeI18nLocale } from '@/i18n/runtime'
import { setConnectionBaseResolver } from '@/lib/api'
import { oauthStatus, oauthStatusIsUnknown, portalAgentSignIn } from '@/lib/auth'
import { LOCAL_CONNECTION_ID, setConnectionIdResolver } from '@/lib/backend-scope'
import { errorText, ownWords } from '@/lib/error-text'
import { emitConnectionApplied } from '@/lib/hermes-desktop/connection-applied'
import { statusSupportsNativeFlow } from '@/lib/native-auth-decisions'
import { loadString, saveString } from '@/lib/persist'
import { IS_TAURI } from '@/lib/platform'
import { mergeSshSecrets } from '@/lib/secure-store'
import { WEBVIEW_ID } from '@/lib/webview-id'
import {
  $activeConnection,
  type ConnectionDescriptorHint,
  describeConnection,
  publishActiveConnection
} from '@/store/active-connection'
import { atom, computed } from '@/store/atom'
import { authenticate, keepSession } from '@/store/connection'
import { isLatched, releaseLatch } from '@/store/connection-latches'
import {
  acquireTunnel,
  connectionBase,
  liveTunnelBase,
  setTunnelAnswerSaver,
  type TunnelLease
} from '@/store/connection-tunnels'
import { disposeSecondariesForConnection } from '@/store/gateway'
import type { AuthMode, Connection, GatewayMode } from '@/store/gateway-config'
import { $restoring, loadGatewayTarget, takePendingOAuth } from '@/store/gateway-restore'
import { broadcastGatewaySwitch } from '@/store/gateway-switch-broadcast'
import { notify } from '@/store/notifications'
import {
  $activeGatewayProfile,
  $newChatProfile,
  $showAllProfiles,
  captureNewChatSource,
  normalizeProfileKey,
  requestFreshSession
} from '@/store/profile'
import { $connection as $desktopConnection } from '@/store/session'
import type { KeptSshAnswer } from '@/store/ssh-answers'

/**
 * THE REGISTRY, as the webview sees it (MJXHRM-446).
 *
 * Rust owns the document, the credentials and the probe; this store owns the
 * non-secret projection, the ACTIVE pointer and the switch. Two rules keep that
 * split honest:
 *
 *  • nothing here ever holds a token. `hasToken` and a four-character
 *    `tokenPreview` are the whole surface, and a save's credential fields are
 *    write-only — they go into `connections_save` and are never echoed back.
 *  • the active pointer is published by `publishActiveConnection`, in one
 *    `batch()`. This module decides WHICH connection; it does not write the
 *    six flags that describe how the connection is doing.
 *
 * With exactly one connection every path below is either skipped or byte-
 * identical to the pre-registry behaviour — that is acceptance criterion 1, and
 * it is why `$hasMultipleConnections` gates every piece of new chrome.
 */

export interface ConnectionView {
  id: string
  kind: GatewayMode
  label: string
  order: number
  url?: string
  authMode?: 'none' | 'oauth' | 'token'
  org?: string
  host?: string
  user?: string
  port?: number
  keyPath?: string
  remoteHermesPath?: string
  remoteProfile?: string
  /** Whether a token is stored. NEVER the bytes. */
  hasToken: boolean
  /** Last four characters — "is this the one I pasted?". */
  tokenPreview?: string
  /** Header NAMES only; the values live in the keyring. */
  headerNames: string[]
  hasSshKey: boolean
  hasSshPassphrase: boolean
  hasSshPassword: boolean
  /** Whether this row owns the pre-registry keyring accounts and pool scope. */
  legacy: boolean
}

export interface RegistryView {
  version: number
  primary: string
  launchMode: 'last-used' | 'primary'
  lastUsed: string
  connections: ConnectionView[]
  /** Present when the document was unusable and was rebuilt (rule 9). */
  degraded?: string
  localSupported: boolean
  readOnly: boolean
  keyringAvailable: boolean
}

export interface ProbeLeg {
  ok: boolean
  status?: number
  ms: number
  error?: string
}

export type ProbeVerdict =
  | 'ok'
  | 'credential-rejected'
  | 'unreachable'
  | 'auth-required'
  | 'skipped-no-token'
  | 'ws-unreachable'
  | 'timeout'

export interface ProbeResult {
  ok: boolean
  http: ProbeLeg
  ws: ProbeLeg
  verdict: ProbeVerdict
  needsOauthLogin: boolean
  installId?: string
  version?: string
  authFlows: string[]
  authRequired: boolean
}

export interface ResolvedDial {
  connectionId: string
  scopeKey: string
  baseUrl?: string
  mode: GatewayMode
  authMode?: 'none' | 'oauth' | 'token'
  profile?: string
  remoteHost?: string
  label: string
  kind: GatewayMode
  tokenAttached: boolean
  headerNames: string[]
  /** Absent for the legacy owner — see `ActiveConnection.dialConnectionId`. */
  dialConnectionId?: string
}

export interface ConnectionSaveInput {
  id?: string
  kind: GatewayMode
  label: string
  url?: string
  authMode?: 'none' | 'oauth' | 'token'
  /** WRITE-ONLY. `''` deletes the stored token; omitted leaves it alone. */
  token?: string
  /** WRITE-ONLY, same rules, filtered through Rust's allowlist. */
  headers?: Record<string, string>
  org?: string
  host?: string
  user?: string
  port?: number
  keyPath?: string
  remoteHermesPath?: string
  remoteProfile?: string
  privateKeyPem?: string
  passphrase?: string
  password?: string
}

export interface SaveOutcome {
  registry: RegistryView
  connectionId: string
  dialFieldsChanged: boolean
  droppedHeaders: string[]
}

const EMPTY: RegistryView = {
  connections: [],
  keyringAvailable: false,
  lastUsed: LOCAL_CONNECTION_ID,
  launchMode: 'last-used',
  localSupported: false,
  primary: LOCAL_CONNECTION_ID,
  readOnly: false,
  version: 2
}

export const $connectionsRegistry = atom<RegistryView>(EMPTY)

/**
 * The one gate for every piece of source chrome.
 *
 * With a single connection the switcher row, the source chip and "Update
 * everything" are ABSENT — not disabled, not collapsed. Acceptance criterion 1
 * is that such an install looks exactly like today's.
 */
export const $hasMultipleConnections = computed(
  $connectionsRegistry,
  registry => registry.connections.length > 1
)

/**
 * Desktop's: the source the FOLD is on — the identity of the descriptor the boot
 * hook last published, not a guess from `primary`. Null until it has published
 * one. (`store/active-connection`'s atom of the same name is the pointer the
 * bridge answers from, which leads this one by a dial.)
 */
export const $activeConnectionId = computed($desktopConnection, connection => connection?.connectionId ?? null)

/** Desktop's: the source a switch is preflighting, for the switcher's spinner. */
export const $pendingConnectionId = atom<null | string>(null)

const LAST_PROFILE_KEY = 'hermes.connections.lastProfileByConnection'
const LAST_PROFILE_MAX = 64

function loadLastProfiles(): Record<string, string> {
  try {
    const parsed = JSON.parse(loadString(LAST_PROFILE_KEY) || '{}') as unknown

    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {}
  } catch {
    return {}
  }
}

/** Which profile each source was last used on. A CONVENIENCE, never a source of
 *  truth: a missing entry is `default`, and a full quota is swallowed. */
export const $lastProfileByConnection = atom<Record<string, string>>(loadLastProfiles())

export function rememberProfile(connectionId: string, profile: string): void {
  const next = { ...$lastProfileByConnection.get(), [connectionId]: profile }
  const keys = Object.keys(next)

  // Bounded, oldest-inserted first. Object key order is insertion order for
  // string keys, which is exactly the LRU-ish answer this needs.
  for (const key of keys.slice(0, Math.max(0, keys.length - LAST_PROFILE_MAX))) {
    delete next[key]
  }

  $lastProfileByConnection.set(next)

  try {
    saveString(LAST_PROFILE_KEY, JSON.stringify(next))
  } catch {
    // Storage disabled or full. The registry itself lives in Rust, so the only
    // thing lost is which profile a source reopens on — the one deliberate
    // silence in this system.
  }
}

/**
 * The store is read once per WebView, and every window of the origin writes it:
 * a peer re-homing on another window's switch reads the profile that window
 * just remembered, not the one this page loaded with.
 */
export function reloadLastProfiles(): void {
  $lastProfileByConnection.set(loadLastProfiles())
}

// Desktop's writer (`apps/desktop/src/store/connections.ts`): remember one
// profile per source, so switching machines is a re-home rather than a reset to
// `default`. Only once the descriptor confirms the profile the rail names —
// which rejects the startup window where the profile atom still carries the
// previous run's. Desktop's `registryScoped` guard is for its v1 per-profile
// aliases; here every descriptor's id comes from the Rust registry.
computed([$activeConnectionId, $activeGatewayProfile, $desktopConnection], (connectionId, profile, connection) => ({
  connectionId,
  descriptorProfile: normalizeProfileKey(connection?.profile),
  profile: normalizeProfileKey(profile)
})).subscribe(({ connectionId, descriptorProfile, profile }) => {
  if (!connectionId || descriptorProfile !== profile || $lastProfileByConnection.get()[connectionId] === profile) {
    return
  }

  rememberProfile(connectionId, profile)
})

export function lastProfileFor(connectionId: string): null | string {
  const held = $lastProfileByConnection.get()[connectionId]

  return held && held !== 'default' ? held : null
}

/** The same memory, `default` included: a source left on `default` is not a
 *  source never used, which falls to its row's own profile. */
function heldProfileFor(connectionId: string): null | string {
  return $lastProfileByConnection.get()[connectionId]?.trim() || null
}

export function connectionById(id: null | string): ConnectionView | undefined {
  return id ? $connectionsRegistry.get().connections.find(row => row.id === id) : undefined
}

// --------------------------------------------------------------------------
// Rust
// --------------------------------------------------------------------------

async function call<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  return invoke<T>(command, args)
}

export async function refreshConnections(): Promise<RegistryView> {
  const registry = await call<RegistryView>('connections_list')

  $connectionsRegistry.set(registry)

  return registry
}

export async function saveConnection(input: ConnectionSaveInput): Promise<SaveOutcome> {
  const outcome = await call<SaveOutcome>('connections_save', { input })

  $connectionsRegistry.set(outcome.registry)

  return outcome
}

export async function removeConnection(connectionId: string): Promise<RegistryView> {
  const registry = await call<RegistryView>('connections_remove', { connectionId })

  $connectionsRegistry.set(registry)

  return registry
}

export async function setPrimaryConnection(connectionId: string): Promise<RegistryView> {
  const registry = await call<RegistryView>('connections_set_primary', { connectionId })

  $connectionsRegistry.set(registry)

  return registry
}

export async function setLaunchMode(launchMode: 'last-used' | 'primary'): Promise<RegistryView> {
  const registry = await call<RegistryView>('connections_set_launch_mode', { launchMode })

  $connectionsRegistry.set(registry)

  return registry
}

/**
 * The two-leg health probe.
 *
 * MJXHRM-412's `statusSupportsNativeFlow` gets its first production caller here:
 * it decides whether a gated row offers "signs in with your browser" or the
 * in-app RFC 8252 flow, which is a different sentence and a different button.
 */
export async function testConnection(connectionId: string): Promise<ProbeResult & { nativeFlow: boolean }> {
  const result = await call<ProbeResult>('connections_test', { connectionId })

  return { ...result, nativeFlow: statusSupportsNativeFlow({ auth_flows: result.authFlows }) }
}

export function connectionsRoster(force = false): Promise<{
  agents: { connectionId: string; profile: string; handle: string; label: string; isDefault: boolean }[]
  /** `observed` distinguishes a source that ANSWERED from one that was merely
   *  seeded by the connect-on-demand carve-out. `ok` cannot: a seeded list is
   *  still a list. Anything asking "is a backend really there" reads this. */
  sources: { connectionId: string; ok: boolean; observed: boolean; error?: string }[]
}> {
  return call('connections_roster', {
    activeConnectionId: $activeConnection.get()?.connectionId ?? null,
    force
  })
}

// --------------------------------------------------------------------------
// Identity — reconciliation C1
// --------------------------------------------------------------------------
//
// MJXHRM-480 published `setConnectionIdResolver` precisely so the registry does
// not mint a SECOND identity beside `connectionIdOf`. Registered at module load
// and never unregistered: with a registry, the registry's id is the answer, and
// the derivation is only the pre-registry fallback for a connection with no row.
setConnectionIdResolver(connection => {
  if (!connection) {
    return null
  }

  const active = $activeConnection.get()

  // The live descriptor first — it is the only thing that knows which ROW a
  // dialled connection came from (two rows can share a base URL until the
  // duplicate check catches them, and an ssh baseUrl is ephemeral by design).
  if (active && active.connection === connection) {
    return active.connectionId
  }

  const registry = $connectionsRegistry.get()

  if (connection.mode === 'local') {
    return registry.connections.some(row => row.id === LOCAL_CONNECTION_ID) ? LOCAL_CONNECTION_ID : null
  }

  return registry.connections.find(row => row.url && row.url === connection.baseUrl)?.id ?? null
})

// `api({connectionId})` asks here for the base URL. A hook rather than an import
// because `lib/api.ts` is a leaf this module transitively depends on. A local or
// SSH row has no URL; its live tunnel in this window stands in (MJXHRM-592).
setConnectionBaseResolver(connectionId => connectionBase(connectionById(connectionId)?.url, connectionId))

/**
 * Keep an answer a tunnel's Connect was given (MJXHRM-592), where that row's
 * dials read it: the legacy owner's bare accounts through the configurator's
 * own write, a registered row's owned accounts through the editor's save. A
 * secret is not a dial field, so the save recycles nothing.
 */
export async function saveTunnelAnswer(connectionId: string, answer: KeptSshAnswer): Promise<void> {
  const row = connectionById(connectionId)

  if (!row) {
    return
  }

  if (row.legacy) {
    await mergeSshSecrets(answer)

    return
  }

  await saveConnection({
    host: row.host,
    id: row.id,
    keyPath: row.keyPath,
    kind: row.kind,
    label: row.label,
    port: row.port,
    remoteHermesPath: row.remoteHermesPath,
    remoteProfile: row.remoteProfile,
    user: row.user,
    ...answer
  })
}

setTunnelAnswerSaver(saveTunnelAnswer)

// --------------------------------------------------------------------------
// Boot + switching
// --------------------------------------------------------------------------

let restoreAttempted = false
let degradedNoticed = false

/**
 * Seed the registry (once, from the pre-registry target) and publish the roster.
 * Dials nothing and publishes no identity: `restoreLaunchConnection` does that.
 */
export async function loadConnectionsRegistry(): Promise<RegistryView> {
  // Rust cannot read `localStorage`, so the webview hands over the one
  // non-secret value it already holds. Idempotent once the document exists.
  const registry = await call<RegistryView>('connections_migrate', { legacyTarget: loadGatewayTarget() })

  $connectionsRegistry.set(registry)

  if (registry.degraded && !degradedNoticed) {
    degradedNoticed = true
    // Rule 9. "You have one gateway" and "your gateway list was eaten" must
    // never look the same.
    notify({
      kind: 'warning',
      message: translateNow('settings.connections.degradedMessage'),
      title: translateNow('settings.connections.degradedTitle')
    })
  }

  return registry
}

/** Desktop's names for the same two things. */
export const refreshConnectionsRegistry = refreshConnections

export function setConnectionsRegistry(registry: RegistryView): void {
  $connectionsRegistry.set(registry)
}

/**
 * Desktop's switcher calls this on mount to load the roster and restore the
 * launch source. Here the launch source is `boot.ts`'s, published before the
 * fold's first dial, so by the time a switcher exists there is nothing left to
 * restore — and a second restore would re-home a window the user already moved.
 */
export async function initializeConnectionsRegistry(): Promise<RegistryView | null> {
  return IS_TAURI ? refreshConnections() : null
}

function hintFor(resolved: ResolvedDial): ConnectionDescriptorHint {
  return {
    connectionId: resolved.connectionId,
    dialConnectionId: resolved.dialConnectionId ?? null,
    label: resolved.label
  }
}

/**
 * The identity of a resolved row, dialling nothing. A local or SSH row has no
 * address of its own: `baseUrl` is its live tunnel in this window, and empty
 * until the fold's first dial finds one (the bridge's `followTunnelBase`).
 */
function identityOf(resolved: ResolvedDial, connection?: Connection) {
  const profile = resolved.profile ?? null
  const tunnelled = resolved.mode === 'local' || resolved.mode === 'ssh'

  return describeConnection(
    connection
      ? { ...connection, mode: resolved.mode, profile }
      : {
          // A tunnel's token never leaves Rust, which attaches it by base.
          authMode: tunnelled ? 'token' : resolved.mode === 'cloud' ? 'oauth' : (resolved.authMode ?? 'none'),
          baseUrl: resolved.baseUrl ?? liveTunnelBase(resolved.connectionId) ?? '',
          mode: resolved.mode,
          profile,
          ...(resolved.remoteHost && { remoteHost: resolved.remoteHost })
        },
    hintFor(resolved)
  )
}

/**
 * THE profile derivation, and the only one: the profile named, else the one this
 * source was last used on, else its row's own (Rust's fallback), else `default`.
 * It lands in the identity (`ActiveConnection.profile`), which is what the
 * bridge's `primaryProfile()` reads — the socket, `profile.get`, the scope key
 * and the hook's adopted profile are one value.
 */
function resolveConnection(connectionId: string, named: null | string = null): Promise<ResolvedDial> {
  return call<ResolvedDial>('connections_resolve', { connectionId, profile: named ?? heldProfileFor(connectionId) })
}

/** The row a registry names for launch, if it still has it. */
function launchTarget(registry: RegistryView, owner: boolean): null | string {
  const has = (id: string) => registry.connections.some(row => row.id === id)
  const lastUsed = has(registry.lastUsed) ? registry.lastUsed : registry.primary
  // The launch mode is the OWNER's question. Every other window opens onto the
  // source the app is on, which is the last one a switch remembered.
  const target = owner && registry.launchMode === 'primary' ? registry.primary : lastUsed

  return has(target) ? target : null
}

/**
 * A mobile sign-in navigated this WebView away and back (`beginOAuthLogin`):
 * finish the switch it interrupted. The session outlived the reload, so the
 * preflight passes without a login page — and a cancelled or expired one falls
 * through to the ordinary launch instead of navigating again.
 */
async function resumePendingSignIn(registry: RegistryView): Promise<boolean> {
  const pending = takePendingOAuth()

  if (!pending) {
    return false
  }

  const row = registry.connections.find(entry =>
    pending.connectionId ? entry.id === pending.connectionId : entry.url === pending.base
  )

  if (!row || !(await oauthStatus(pending.base).catch(() => null))?.signedIn) {
    return false
  }

  // Nobody clicked: a session that lapsed after all must not navigate again. A
  // failure here is the ordinary launch's to recover from.
  await selectConnection(row.id, { allowInteractive: false }).catch(() => {})

  return $activeConnection.get()?.connectionId === row.id
}

/**
 * Publish where this window launches — and dial nothing (MJXHRM-602).
 *
 * The identity is all desktop's fold needs: its boot hook dials through the
 * bridge, which answers from `$activeConnection`. A phone with nothing
 * configured has no row to name, publishes nothing, and stays on the connect
 * screen.
 *
 * `owner` is the window that owns the app's persisted state: it alone seeds the
 * registry and honours the launch mode. `boot.ts` holds the bridge on this
 * (`holdForLaunch`), so it must always settle.
 */
export async function restoreLaunchConnection(owner: boolean): Promise<void> {
  if (restoreAttempted || !IS_TAURI) {
    return
  }

  restoreAttempted = true

  try {
    const registry = await (owner ? loadConnectionsRegistry() : refreshConnections())

    if ($activeConnection.get() || (await resumePendingSignIn(registry))) {
      return
    }

    const target = launchTarget(registry, owner)

    if (!target) {
      return
    }

    const resolved = await resolveConnection(target)

    // A person got there first while the registry was being read.
    if ($activeConnection.get()) {
      return
    }

    publishActiveConnection(identityOf(resolved))

    if (owner) {
      const moved = target !== registry.lastUsed
      const commit = moved ? stampCommit() : null

      // Desktop's restore remembers the source it lands on, which is also what
      // every later window launches onto. Swallowed: see the command's own note.
      void call('connections_set_last_used', { connectionId: target })
        .catch(() => {})
        .then(() => {
          // The launch mode moved the pointer (`primary`): a window booting
          // alongside read `lastUsed` before this write and sits on the old
          // one. The launch is a commit like any switch, told once the write
          // has landed — whoever read before it was listening before this — and
          // a window a person has since moved ignores it (`SwitchCommit`).
          if (commit) {
            broadcastGatewaySwitch(resolved.mode, { connectionId: target, mode: resolved.mode }, commit.at)
          }
        })
    }
  } catch {
    // Unconfigured is a state the app can stand in; a thrown boot is not. The
    // reason is not logged: Rust's text can name the gateway.
    console.warn('[connections] launch connection unavailable')
  } finally {
    $restoring.set(false)
  }
}

/**
 * A tunnel failure as copy: Rust's own message can name the host. The cause is
 * what a connect form branches on (a dismissed prompt, a remote with no Hermes)
 * and nothing more — never Rust's text.
 */
function tunnelFailure(error: unknown): Error {
  const { kind, sshKind, terminal } = (error ?? {}) as { kind?: unknown; sshKind?: unknown; terminal?: unknown }

  return new Error(tunnelErrorMessage(error, TRANSLATIONS[getRuntimeI18nLocale()].settings.gateway), {
    cause: { kind, sshKind, terminal }
  })
}

/**
 * A URL or cloud preflight failure a person may read. A rejected `invoke` is a
 * bare Rust string that quotes the URL it could not reach (`transport.rs` masks
 * only the query), and the switcher toasts whatever this throws — so only an
 * `Error`, which is this app's own words and may be typed
 * (`GatewaySignInRequiredError`), passes. No cause: there is nothing under it
 * that may be shown.
 */
function preflightFailure(error: unknown): Error {
  return ownWords(error, translateNow('settings.connections.verdict', 'unreachable'))
}

/**
 * PHASE 1 of a switch: prove the target without activating it. Whatever the
 * window is on stays bound and painted, so a dead target costs nothing.
 *
 *  • local / SSH — hold its tunnel. The lease is kept through the publish and
 *    then let go: Rust lingers an unheld slot, so the fold's own acquire finds
 *    it warm.
 *  • cloud — the agent session, renewed by the SILENT portal cascade.
 *  • a URL — the status probe and whatever sign-in it asks for.
 */
async function preflight(
  resolved: ResolvedDial,
  options: { attemptId?: string; interactive: boolean }
): Promise<{ connection: Connection; lease: null | TunnelLease }> {
  if (resolved.mode === 'local' || resolved.mode === 'ssh') {
    const lease = await acquireTunnel(resolved.connectionId, {
      attemptId: options.attemptId,
      interactive: options.interactive,
      label: resolved.label
    }).catch(error => {
      throw tunnelFailure(error)
    })

    return {
      connection: {
        authMode: 'token',
        baseUrl: lease.baseUrl(),
        mode: resolved.mode,
        ...(resolved.remoteHost && { remoteHost: resolved.remoteHost })
      },
      lease
    }
  }

  const baseUrl = resolved.baseUrl ?? ''

  try {
    if (resolved.mode === 'cloud') {
      const live = await oauthStatus(baseUrl)

      // "Could not tell" is not "signed out" (see `authenticate`). Why is Rust's
      // text, which names the host.
      if (oauthStatusIsUnknown(live)) {
        throw preflightFailure(null)
      }

      if (!live.signedIn && !(await portalAgentSignIn(baseUrl)).connected) {
        throw new Error('Could not sign in to this agent')
      }

      return { connection: { authMode: 'oauth', baseUrl, mode: 'cloud' }, lease: null }
    }

    return {
      connection: await authenticate({
        allowInteractive: options.interactive,
        connectionId: resolved.connectionId,
        url: baseUrl
      }),
      lease: null
    }
  } catch (error) {
    throw preflightFailure(error)
  }
}

/** A newer click owns the outcome. Bumped before every preflight. */
let switchRevision = 0

/**
 * Which commit wins when two windows switch at once: the LATER one, everywhere.
 *
 * Each commit is stamped `(at, origin)` and rides the broadcast. `at` is the
 * wall clock, pushed past every stamp this window has seen (a Lamport clock),
 * so a commit made after hearing a peer's is always newer than it; `origin` —
 * the WebView's id — breaks a tie. The order is total, so two crossed
 * broadcasts are compared the same way at both ends: the newer window ignores
 * the older follow, the older one takes the newer, and both land on one source.
 */
export interface SwitchCommit {
  at: number
  origin: string
}

/** The newest commit this window knows of: its own, or a peer's it was told. */
let latestCommit: SwitchCommit = { at: 0, origin: '' }

export function isNewerCommit(next: SwitchCommit, than: SwitchCommit): boolean {
  return next.at === than.at ? next.origin > than.origin : next.at > than.at
}

function stampCommit(): SwitchCommit {
  latestCommit = { at: Math.max(Date.now(), latestCommit.at + 1), origin: WEBVIEW_ID }

  return latestCommit
}

export interface SelectConnectionOptions {
  /**
   * Is a person asking? TRUE by default, because that is desktop's contract: its
   * switcher, profile rail and settings call a bare `selectConnection(id)`, and
   * every one of those is a click. A person may be asked a question — an SSH
   * passphrase or host key, or a login page, which on a phone is a one-way door
   * (`authenticate`) and is still what the click asked for.
   *
   * A caller that is NOT a person passes `false` and gets the failure instead
   * of the question: the post-sign-in resume (`resumePendingSignIn`, and the
   * legacy `autoRestoreConnection`). A peer's re-home and the launch never come
   * through here at all (`followConnection`, `restoreLaunchConnection`).
   */
  allowInteractive?: boolean
  /** The SSH attempt the caller follows progress on. Interactive only. */
  attemptId?: string
  /** Desktop's: land on this profile of the source instead of the one last used
   *  there. The fleet profile rail passes the exact square the user clicked. */
  profile?: null | string
  /** Run the switch even onto the source the window is on: its row was just
   *  saved (`applyConnection`), so its address or its credential may be new. */
  reapply?: boolean
}

/**
 * What a switch leaves behind besides the socket, as desktop's select does once
 * its target is active — so nothing of the source the window left outlives it:
 * a `$newChatProfile` naming a profile the new source lacks would mint the next
 * chat there. The source is named, not read: the fold re-dials AFTER this, so
 * its active route is still the one being left.
 */
function landNewChatsOn(connectionId: string, profile: string): void {
  $newChatProfile.set(profile)
  captureNewChatSource(connectionId)
  requestFreshSession()
}

/**
 * Switch this window onto another source — in two phases (MJXHRM-602), the
 * contract desktop's `selectConnection` has: a dead target costs nothing.
 *
 *  1. PREFLIGHT, activating nothing (`preflight`). A failure throws with the
 *     window still on the source it came from.
 *  2. COMMIT, synchronously: publish the identity → remember it → drop the
 *     registry secondaries on that id (it is the primary now) → tell the peer
 *     windows → `emitConnectionApplied()`, which is what makes the boot hook
 *     soft-switch: wipe, then re-dial the primary through the bridge → desktop's
 *     own landing (browse mode off, new chats on the target).
 *
 * Desktop's select opens a registry SECONDARY and never moves the primary.
 * Re-homing the primary is universal's, for mobile: a phone has no launch
 * backend, so the primary has to be the source the window is on.
 *
 * A re-click is a no-op except for `lastUsed` — and, like desktop's, it CANCELS
 * a switch that is still preflighting: backing out of a slow target is a click
 * on the source the window never left. A LATCHED source refuses with its
 * reason; a superseded switch publishes nothing, says nothing (its failure is
 * nobody's any more) and still gives its tunnel back; and
 * `connections_set_last_used` is swallowed, because a full disk must not turn a
 * successful switch into a failed one.
 */
export async function selectConnection(connectionId: string, options: SelectConnectionOptions = {}): Promise<void> {
  const explicitProfile = (options.profile ?? '').trim()
  const profile = explicitProfile ? normalizeProfileKey(explicitProfile) : lastProfileFor(connectionId)

  if (
    !options.reapply &&
    $activeConnection.get()?.connectionId === connectionId &&
    (!explicitProfile || profile === normalizeProfileKey(lastProfileFor(connectionId)))
  ) {
    if ($pendingConnectionId.get() !== null) {
      // Another source is preflighting. Its revision goes stale here, so it
      // publishes nothing when it lands; its own `finally` returns the lease.
      switchRevision += 1
      $pendingConnectionId.set(null)
    }

    // Desktop's: picking a source is a concrete-source action, so it leaves
    // "All profiles" even when the source is the one already active.
    if ($showAllProfiles.get()) {
      $showAllProfiles.set(false)
      landNewChatsOn(connectionId, normalizeProfileKey(profile))
    }

    // Already here. Remember it (the launch mode may read it) and stop — a
    // re-dial would drop a live socket for nothing.
    void call('connections_set_last_used', { connectionId }).catch(() => {})

    return
  }

  const latch = isLatched(connectionId)

  if (latch) {
    notify({
      kind: 'warning',
      message: translateNow('settings.connections.latchedMessage', latch),
      title: translateNow('settings.connections.latchedTitle')
    })

    return
  }

  const revision = ++switchRevision
  let lease: null | TunnelLease = null

  $pendingConnectionId.set(connectionId)

  try {
    const resolved = await resolveConnection(connectionId, explicitProfile ? profile : null)

    const proven = await preflight(resolved, {
      attemptId: options.attemptId,
      interactive: options.allowInteractive !== false
    })

    lease = proven.lease

    if (revision !== switchRevision) {
      // A later click owns the outcome. Publishing here would re-home the app
      // onto a source the user has already navigated away from.
      return
    }

    const next = identityOf(resolved, proven.connection)
    const commit = stampCommit()

    publishActiveConnection(next)
    // Before the emit: the peers that follow read this memory, not the payload.
    rememberProfile(connectionId, next.profile)
    releaseLatch(connectionId)
    // Swallowed ON PURPOSE: see the command's own note.
    void call('connections_set_last_used', { connectionId }).catch(() => {})
    // The registry may hold this source as a secondary (a tab, a relay). It is
    // the primary's now, and one id must not be both.
    disposeSecondariesForConnection(connectionId)
    broadcastGatewaySwitch(resolved.mode, { connectionId, mode: resolved.mode }, commit.at)
    emitConnectionApplied()
    $showAllProfiles.set(false)
    landNewChatsOn(connectionId, next.profile)
    // A deliberate connect's session is the user's to keep, sign-out latch or not.
    void keepSession().catch(() => {})
  } catch (error) {
    // Desktop's: a superseded switch's failure belongs to nobody.
    if (revision === switchRevision) {
      throw error
    }
  } finally {
    lease?.release()

    if (revision === switchRevision) {
      $pendingConnectionId.set(null)
    }
  }
}

/**
 * A PEER window switched (`store/gateway-switch-sync.ts`): put this window on
 * the same source. The initiator has already proven it, so there is no
 * preflight, nothing is remembered or re-broadcast, and nothing may prompt —
 * the fold's own dial surfaces whatever this window still lacks.
 *
 * `commit` is the peer's stamp (`SwitchCommit`): a follow no newer than what
 * this window already knows of is the losing half of a crossed pair, and is
 * dropped. A follow supersedes a switch this window is still preflighting, so
 * it takes the spinner down with it.
 */
export async function followConnection(connectionId: string, commit?: SwitchCommit): Promise<void> {
  if (commit) {
    if (!isNewerCommit(commit, latestCommit)) {
      return
    }

    latestCommit = commit
  }

  if ($activeConnection.get()?.connectionId === connectionId) {
    return
  }

  const revision = ++switchRevision

  $pendingConnectionId.set(null)
  reloadLastProfiles()

  const resolved = await resolveConnection(connectionId)

  if (revision !== switchRevision) {
    return
  }

  const next = identityOf(resolved)

  publishActiveConnection(next)
  disposeSecondariesForConnection(connectionId)
  emitConnectionApplied()
  landNewChatsOn(connectionId, next.profile)
}

/** What a connect form names: a row's dial fields and its write-only secrets. */
export type ConnectionTarget = Omit<ConnectionSaveInput, 'id' | 'label'> & { label?: string }

/** `user@host:port`, as Rust's `split_ssh_host` reads it. */
function sshParts(target: ConnectionTarget): { host: string; port: number; user: string } {
  const raw = (target.host ?? '').trim()
  const at = raw.indexOf('@')
  const rest = at > 0 ? raw.slice(at + 1) : raw
  const colon = rest.lastIndexOf(':')
  const typedPort = colon > 0 ? Number(rest.slice(colon + 1)) : NaN

  return {
    host: Number.isInteger(typedPort) ? rest.slice(0, colon) : rest,
    port: Number.isInteger(typedPort) ? typedPort : (target.port ?? 22),
    user: at > 0 ? raw.slice(0, at).trim() : (target.user ?? '')
  }
}

/** The row that already points where `target` does (Rust's `dial_identity`). */
function rowFor(target: ConnectionTarget, registry: RegistryView): ConnectionView | undefined {
  if (target.kind === 'local') {
    return registry.connections.find(row => row.kind === 'local')
  }

  if (target.kind === 'ssh') {
    const wanted = sshParts(target)

    return registry.connections.find(
      row =>
        row.kind === 'ssh' &&
        row.host === wanted.host &&
        (row.user ?? '') === wanted.user &&
        (row.port ?? 22) === wanted.port &&
        (row.remoteProfile ?? '') === (target.remoteProfile ?? '')
    )
  }

  const url = (target.url ?? '').trim().replace(/\/+$/, '')
  const withScheme = /^https?:\/\//i.test(url) ? url : `http://${url}`

  return registry.connections.find(row => (row.kind === 'remote' || row.kind === 'cloud') && row.url === withScheme)
}

function labelFor(target: ConnectionTarget, registry: RegistryView): string {
  const parts = target.kind === 'ssh' ? sshParts(target) : null

  const base =
    target.label?.trim() ||
    (parts
      ? parts.user
        ? `${parts.user}@${parts.host}`
        : parts.host
      : (target.url ?? '').trim().replace(/^https?:\/\//i, ''))

  const taken = new Set(registry.connections.map(row => row.label.trim().toLowerCase()))
  let label = base

  for (let n = 2; taken.has(label.toLowerCase()); n++) {
    label = `${base} (${n})`
  }

  return label
}

/**
 * Save the source a connect form names — onto the row that already points
 * there, else a new one. Rust keeps the credentials, under that row's own
 * accounts; nothing the form typed stays in the webview.
 */
export async function saveConnectionTarget(target: ConnectionTarget): Promise<string> {
  const registry = await refreshConnections()
  const row = rowFor(target, registry)

  // This device's own backend has nothing to save.
  if (row?.kind === 'local') {
    return row.id
  }

  return (await saveConnection({ ...target, id: row?.id, label: row?.label ?? labelFor(target, registry) }))
    .connectionId
}

/** "Save for next restart": the saved source is where the next launch lands. */
export async function saveLaunchTarget(target: ConnectionTarget): Promise<void> {
  const connectionId = await saveConnectionTarget(target)

  $connectionsRegistry.set(await call<RegistryView>('connections_set_last_used', { connectionId }))
}

/**
 * A connect form's Connect: desktop's `applyConnectionConfig` — save, then
 * switch onto it. Saved BEFORE the switch, like desktop's: on a phone the
 * sign-in navigates this WebView away, and the post-reload resume needs a row
 * to land on.
 */
export async function applyConnection(
  target: ConnectionTarget,
  options: Pick<SelectConnectionOptions, 'allowInteractive' | 'attemptId'> = {}
): Promise<string> {
  const connectionId = await saveConnectionTarget(target)

  await selectConnection(connectionId, { ...options, reapply: true })

  return connectionId
}

/** Re-publish the live descriptor against a freshly saved row (a rename must be
 *  visible in the chip without a reconnect). */
function republishActive(registry: RegistryView): void {
  const active = $activeConnection.get()

  if (!active) {
    return
  }

  const row = registry.connections.find(entry => entry.id === active.connectionId)

  if (row && row.label !== active.label) {
    publishActiveConnection({ ...active, label: row.label })
  }
}

/**
 * Follow the registry from every window.
 *
 * `app.emit` on the Rust side, so a rename made in a settings Activity reaches
 * the shell that is painting the source chip. Started from `boot.ts`.
 */
export function startConnectionsWatcher(): () => void {
  if (!IS_TAURI) {
    return () => {}
  }

  const pending = listen('hermes://connections-changed', () => {
    void refreshConnections()
      .then(republishActive)
      .catch(() => {})
  })

  return () => {
    void pending.then(unlisten => unlisten()).catch(() => {})
  }
}

export const __testing = {
  errorText,
  rememberProfile,
  reset(): void {
    restoreAttempted = false
    degradedNoticed = false
    switchRevision = 0
    latestCommit = { at: 0, origin: '' }
    $connectionsRegistry.set(EMPTY)
    $lastProfileByConnection.set({})
    $pendingConnectionId.set(null)
  }
}

/** Desktop's name for the same reset. */
export const _resetConnectionsForTests = __testing.reset

export type { AuthMode, Connection }
