import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

import { translateNow } from '@/i18n'
import { setConnectionBaseResolver } from '@/lib/api'
import { LOCAL_CONNECTION_ID, setConnectionIdResolver } from '@/lib/backend-scope'
import { errorText } from '@/lib/error-text'
import { statusSupportsNativeFlow } from '@/lib/native-auth-decisions'
import { loadString, saveString } from '@/lib/persist'
import { IS_TAURI } from '@/lib/platform'
import {
  $activeConnection,
  type ConnectionDescriptorHint,
  publishActiveConnection,
  setPendingConnectionHint
} from '@/store/active-connection'
import { atom, computed } from '@/store/atom'
import { connect, connectCloud, connectLocal, connectSsh } from '@/store/connection'
import { isLatched, releaseLatch } from '@/store/connection-latches'
import type { AuthMode, Connection, GatewayMode } from '@/store/gateway-config'
import { loadGatewayTarget } from '@/store/gateway-restore'
import { softSwitchGateway } from '@/store/gateway-soft-switch'
import { broadcastGatewaySwitch } from '@/store/gateway-switch-broadcast'
import { notify, notifyError } from '@/store/notifications'

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

function rememberProfile(connectionId: string, profile: string): void {
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

export function lastProfileFor(connectionId: string): null | string {
  const held = $lastProfileByConnection.get()[connectionId]

  return held && held !== 'default' ? held : null
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
  sources: { connectionId: string; ok: boolean; error?: string }[]
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
// because `lib/api.ts` is a leaf this module transitively depends on.
setConnectionBaseResolver(connectionId => connectionById(connectionId)?.url ?? null)

// --------------------------------------------------------------------------
// Boot + switching
// --------------------------------------------------------------------------

let restoreAttempted = false

/**
 * Read (and, once, seed) the registry.
 *
 * Deliberately NOT on the critical path to the first paint: `$restoring` is
 * still seeded synchronously from `hermes.connection.last`, so the connecting
 * screen renders on frame one with no `invoke` in front of it. And the boot
 * restore stays the boot restore — `autoRestoreConnection()` has already dialled
 * the saved target, so this only RE-POINTS it when the launch mode disagrees.
 * Desktop fires its own dial here, which is how you get two sockets and a
 * flickering picker at launch.
 */
export async function initializeConnectionsRegistry(): Promise<void> {
  if (restoreAttempted || !IS_TAURI) {
    return
  }

  restoreAttempted = true

  try {
    // Rust cannot read `localStorage`, so the webview hands over the one
    // non-secret value it already holds. Idempotent once the document exists.
    const registry = await call<RegistryView>('connections_migrate', { legacyTarget: loadGatewayTarget() })

    $connectionsRegistry.set(registry)

    if (registry.degraded) {
      // Rule 9. "You have one gateway" and "your gateway list was eaten" must
      // never look the same.
      notify({
        kind: 'warning',
        message: translateNow('settings.connections.degradedMessage'),
        title: translateNow('settings.connections.degradedTitle')
      })
    }

    const target = registry.launchMode === 'last-used' ? registry.lastUsed : registry.primary
    const active = $activeConnection.get()

    if (!target || active?.connectionId === target) {
      return
    }

    // The saved dial landed somewhere else (or nowhere): re-point it, once.
    await selectConnection(target)
  } catch (error) {
    // A registry that cannot be read must not stop the app connecting — the
    // pre-registry restore has already run and stands on its own.
    console.warn('[connections] registry unavailable', error)
  }
}

/** A newer click owns the final refresh. Bumped before every dial. */
let switchRevision = 0

function hintFor(resolved: ResolvedDial): ConnectionDescriptorHint {
  return {
    connectionId: resolved.connectionId,
    dialConnectionId: resolved.dialConnectionId ?? null,
    label: resolved.label
  }
}

async function dialResolved(resolved: ResolvedDial): Promise<void> {
  const profile = resolved.profile ?? null

  setPendingConnectionHint(hintFor(resolved))

  switch (resolved.mode) {
    case 'local':
      return connectLocal(profile)

    case 'ssh':
      return connectSsh({
        host: resolved.remoteHost ?? '',
        profile,
        // Every other ssh field, and every secret, is read by Rust from this
        // connection's own registry row and keyring accounts (rule 4).
        ...(connectionById(resolved.connectionId) ?? {})
      })

    case 'cloud':
      return connectCloud(resolved.baseUrl ?? '', profile)

    default:
      return connect({ url: resolved.baseUrl ?? '' })
  }
}

/**
 * Switch the app onto another source.
 *
 * The ordering is the design's §8.3 and every line of it is load-bearing:
 * a re-click is a no-op except for `lastUsed`; a LATCHED source refuses with its
 * reason rather than re-entering a retry loop; the descriptor lookup and the
 * dial resolve CONCURRENTLY so nothing awaits between activation and
 * publication; a stale revision drops out before publishing; and
 * `connections_set_last_used` is swallowed, because a full disk must not turn a
 * successful switch into a failed one.
 */
export async function selectConnection(connectionId: string): Promise<void> {
  const active = $activeConnection.get()

  if (active?.connectionId === connectionId) {
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
  const profile = lastProfileFor(connectionId)

  let resolved: ResolvedDial

  try {
    resolved = await call<ResolvedDial>('connections_resolve', { connectionId, profile })
  } catch (error) {
    notifyError(error, translateNow('settings.connections.switchFailed'))

    return
  }

  try {
    await softSwitchGateway(resolved.mode, () => dialResolved(resolved))
  } catch {
    // `softSwitchGateway` already rolled back onto the previous source and
    // surfaced the failure; a failed switch is never remembered.
    return
  }

  if (revision !== switchRevision) {
    // A later click owns the outcome. Publishing here would re-home the app onto
    // a source the user has already navigated away from.
    return
  }

  const published = $activeConnection.get()

  if (!published || published.connectionId !== resolved.connectionId) {
    // FAIL OPEN (§8.2). The dial completed but the identity did not land — the
    // source was edited or removed mid-dial. Everything stays on what we have,
    // and we say so rather than going quiet (the #89622 lesson).
    console.warn('[connections] descriptor lookup failed mid-dial; keeping the previous source')
    notify({
      kind: 'warning',
      message: translateNow('settings.connections.midDialMessage', resolved.label),
      title: translateNow('settings.connections.midDialTitle')
    })

    return
  }

  rememberProfile(connectionId, published.profile)
  releaseLatch(connectionId)
  // Swallowed ON PURPOSE: see the command's own note.
  void call('connections_set_last_used', { connectionId }).catch(() => {})

  const target = loadGatewayTarget()

  if (target) {
    broadcastGatewaySwitch(resolved.mode, { ...target, connectionId })
  }
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
 * the shell that is painting the source chip. Started from `main.tsx`.
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
    switchRevision = 0
    $connectionsRegistry.set(EMPTY)
    $lastProfileByConnection.set({})
  }
}

export type { AuthMode, Connection }
