/**
 * THE MODEL MAPPING: Electron's connection model ↔ universal's registry rows.
 *
 * Rust owns the registry (`src-tauri/src/connections/registry.rs`), and it was
 * ported from Electron's (`electron/connection-registry.ts`), so the two agree
 * on the four kinds and on almost every field. This file is the whole of where
 * they do not, and it is pure: no store, no Tauri, no I/O.
 *
 * ── A ROW: `ConnectionView` (Rust) → `DesktopRegistryConnection` ─────────────
 *
 *   id, kind, label, org, host, user, port,
 *   keyPath, remoteHermesPath, remoteProfile,
 *   headerNames                      → the same field, the same value
 *   url                              → remote / cloud only. A local or SSH row has
 *                                      no address: it is reached through a tunnel
 *                                      whose loopback port lives in the tunnel
 *                                      store and NEVER appears on a row.
 *   authMode 'oauth' | 'token'       → the same
 *   authMode 'none'                  → absent. Desktop has no such mode (it probes
 *                                      before a save); a row seeded from the
 *                                      pre-registry target carries it, and so does
 *                                      a gateway that asks for nothing.
 *   kind 'cloud', no authMode        → 'oauth' (a cloud agent is always a session)
 *   hasToken                         → tokenSet
 *   tokenPreview                     → tokenPreview, `null` when none
 *   installId                        → absent (the roster learns it; a row does not)
 *   order, legacy, hasSshKey,
 *   hasSshPassphrase, hasSshPassword → NOT exposed. Desktop has no field for them,
 *                                      and `host.connections()` hands rows to plugins.
 *
 * ── THE REGISTRY: `RegistryView` → `DesktopConnectionsRegistry` ──────────────
 *
 *   version, primary, launchMode, lastUsed → the same
 *   secureTokenStorage                     → always `true`. It drives desktop's
 *                                            "store this token as plain text?"
 *                                            offer, and universal has no
 *                                            plaintext credential store to offer:
 *                                            without a keyring Rust refuses the
 *                                            save (`keyring-unavailable`) in its
 *                                            own words.
 *   degraded, localSupported, readOnly,
 *   keyringAvailable                       → NOT exposed (universal's own page
 *                                            reads them from the Rust view).
 *
 * ── A SAVE: `DesktopRegistryConnectionInput` → `ConnectionSaveInput` ─────────
 *
 * MERGE, NEVER REPLACE. Desktop's form sends only the fields it shows, and Rust
 * (`normalize_connection_input`) keeps every field an input omits — and never
 * changes a row's kind. So an SSH row saved from desktop's form keeps its user,
 * port, remote Hermes path, remote profile and every stored secret; a cloud row
 * keeps its org; a local row is its label.
 *
 *   token                  → `token`, write-only, straight to Rust's keyring. Never
 *                            returned: a read carries `tokenSet` and four characters.
 *   authMode 'token' with no token, onto a new row or one that is `none` and
 *   holds none             → omitted. The form cannot say `none`, so that `token`
 *                            is its default rather than a decision: a new row is
 *                            stamped `none` and proven at its first dial
 *                            (`discoverGate`), and an existing one is not
 *                            re-dialled for a rename.
 *   headers { name: null } → `null` KEEPS the stored secret (the form loads a
 *                            header by name and never sees its value); a string
 *                            replaces it, `''` deletes it, a name left out of the
 *                            map is dropped from the row.
 *   port: null             → omitted (keeps the row's)
 *   allowPlainTextToken    → dropped. See `secureTokenStorage`.
 *
 * ── THE v1 CONFIG: `DesktopConnectionConfig` ↔ ONE row ───────────────────────
 *
 * Electron's Settings → Gateway edits one "global" connection and keeps the
 * registry's `primary` pointed at it (`reconcileAppliedGlobalConnection`). Here
 * it is one row, chosen in `connection-config.ts`: a target saved through this
 * door and not yet applied, else the row the window is on, else the primary:
 *
 *   mode                    ← the row's kind
 *   remoteUrl, cloudOrg     ← url, org (remote / cloud)
 *   remoteAuthMode          ← 'oauth' for a cloud or OAuth row, else 'token'
 *   remoteTokenSet/Preview  ← hasToken / tokenPreview
 *   remoteOauthConnected    ← Rust's `oauth_status` for the row's URL
 *   ssh*                    ← host, user, port, keyPath, remoteHermesPath, remoteProfile
 *   secureTokenStorage      ← `true`; remoteTokenPlainText, envOverride ← `false`
 *   profile                 ← echoed. A NAMED profile always reads as `local`:
 *                             universal has no per-profile gateway override — a
 *                             profile is a request scope on its connection's one
 *                             unified server, and another gateway is another row.
 *
 * A save writes the row that already points at the target (else a new one) and
 * makes it primary; an apply does that and then switches onto it, as a click.
 */

import type {
  DesktopConnectionConfig,
  DesktopConnectionConfigInput,
  DesktopConnectionsRegistry,
  DesktopRegistryConnection,
  DesktopRegistryConnectionInput
} from '@/global'
import type { ConnectionSaveInput, ConnectionTarget, ConnectionView, RegistryView } from '@/store/connections'

const isRemoteLike = (kind: ConnectionView['kind']): boolean => kind === 'remote' || kind === 'cloud'

function desktopAuthMode(row: Pick<ConnectionView, 'authMode' | 'kind'>): 'oauth' | 'token' | undefined {
  if (!isRemoteLike(row.kind)) {
    return undefined
  }

  if (row.authMode === 'oauth' || row.authMode === 'token') {
    return row.authMode
  }

  return row.kind === 'cloud' ? 'oauth' : undefined
}

export function toDesktopConnection(row: ConnectionView): DesktopRegistryConnection {
  const authMode = desktopAuthMode(row)
  const remote = isRemoteLike(row.kind)
  const ssh = row.kind === 'ssh'

  return {
    id: row.id,
    kind: row.kind,
    label: row.label,
    ...(remote && row.url && { url: row.url }),
    ...(authMode && { authMode }),
    ...(remote && row.org && { org: row.org }),
    ...(ssh && row.host && { host: row.host }),
    ...(ssh && row.user && { user: row.user }),
    ...(ssh && row.port != null && { port: row.port }),
    ...(ssh && row.keyPath && { keyPath: row.keyPath }),
    ...(ssh && row.remoteHermesPath && { remoteHermesPath: row.remoteHermesPath }),
    ...(ssh && row.remoteProfile && { remoteProfile: row.remoteProfile }),
    tokenSet: remote && row.hasToken,
    tokenPreview: (remote && row.tokenPreview) || null,
    headerNames: remote ? [...row.headerNames] : []
  }
}

export function toDesktopRegistry(view: RegistryView): DesktopConnectionsRegistry {
  return {
    version: view.version,
    primary: view.primary,
    launchMode: view.launchMode,
    lastUsed: view.lastUsed,
    secureTokenStorage: true,
    connections: view.connections.map(toDesktopConnection)
  }
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

/** Desktop's form payload as a Rust save. `existing` is the row being edited. */
export function toSaveInput(input: DesktopRegistryConnectionInput, existing?: ConnectionView): ConnectionSaveInput {
  const kind = existing?.kind ?? input.kind
  const save: ConnectionSaveInput = { kind, label: text(input.label) }

  // An id the view does not know is Rust's to refuse (`not-found`).
  if (existing?.id ?? input.id) {
    save.id = existing?.id ?? input.id
  }

  if (isRemoteLike(kind)) {
    const token = text(input.token)

    if (input.url !== undefined) {
      save.url = text(input.url)
    }

    if (token) {
      save.token = token
    }

    const formDefault =
      input.authMode === 'token' && !token && (existing?.authMode ?? 'none') === 'none' && !existing?.hasToken

    if (input.authMode && !formDefault) {
      save.authMode = input.authMode
    }

    if (input.headers && typeof input.headers === 'object') {
      save.headers = { ...input.headers }
    }

    if (text(input.org)) {
      save.org = text(input.org)
    }
  }

  if (kind === 'ssh') {
    if (input.host !== undefined) {
      save.host = text(input.host)
    }

    if (text(input.user)) {
      save.user = text(input.user)
    }

    if (typeof input.port === 'number') {
      save.port = input.port
    }

    if (text(input.keyPath)) {
      save.keyPath = text(input.keyPath)
    }

    if (text(input.remoteHermesPath)) {
      save.remoteHermesPath = text(input.remoteHermesPath)
    }

    if (text(input.remoteProfile)) {
      save.remoteProfile = text(input.remoteProfile)
    }
  }

  return save
}

const EMPTY_CONFIG: DesktopConnectionConfig = {
  envOverride: false,
  mode: 'local',
  profile: null,
  remoteAuthMode: 'token',
  remoteOauthConnected: false,
  remoteTokenPreview: null,
  remoteTokenSet: false,
  secureTokenStorage: true,
  remoteTokenPlainText: false,
  remoteUrl: '',
  cloudOrg: '',
  sshHost: '',
  sshUser: '',
  sshPort: null,
  sshKeyPath: '',
  sshRemoteHermesPath: '',
  sshRemoteProfile: ''
}

/** A row as Electron's v1 config. No row is a local config. */
export function toConnectionConfig(
  row: ConnectionView | undefined,
  facts: { oauthConnected?: boolean; profile?: null | string } = {}
): DesktopConnectionConfig {
  const config = { ...EMPTY_CONFIG, profile: facts.profile ?? null }

  if (!row || row.kind === 'local') {
    return config
  }

  if (row.kind === 'ssh') {
    return {
      ...config,
      mode: 'ssh',
      sshHost: row.host ?? '',
      sshUser: row.user ?? '',
      sshPort: row.port ?? null,
      sshKeyPath: row.keyPath ?? '',
      sshRemoteHermesPath: row.remoteHermesPath ?? '',
      sshRemoteProfile: row.remoteProfile ?? ''
    }
  }

  const authMode = desktopAuthMode(row) ?? 'token'

  return {
    ...config,
    mode: row.kind,
    remoteAuthMode: authMode,
    remoteOauthConnected: authMode === 'oauth' && facts.oauthConnected === true,
    remoteTokenPreview: row.tokenPreview ?? null,
    remoteTokenSet: row.hasToken,
    remoteUrl: row.url ?? '',
    cloudOrg: row.kind === 'cloud' ? (row.org ?? '') : ''
  }
}

/**
 * A v1 payload as the target `saveConnectionTarget` finds a row for (by URL, or
 * by `user@host:port` + remote profile) — so a save lands on the row that
 * already points there, and Rust's merge keeps what the payload does not name.
 */
export function toConnectionTarget(input: DesktopConnectionConfigInput): ConnectionTarget {
  if (input.mode === 'ssh') {
    return {
      kind: 'ssh',
      host: text(input.sshHost),
      ...(text(input.sshUser) && { user: text(input.sshUser) }),
      ...(typeof input.sshPort === 'number' && { port: input.sshPort }),
      ...(text(input.sshKeyPath) && { keyPath: text(input.sshKeyPath) }),
      ...(text(input.sshRemoteHermesPath) && { remoteHermesPath: text(input.sshRemoteHermesPath) }),
      ...(text(input.sshRemoteProfile) && { remoteProfile: text(input.sshRemoteProfile) })
    }
  }

  if (input.mode === 'remote' || input.mode === 'cloud') {
    const token = input.mode === 'remote' && input.remoteAuthMode !== 'oauth' ? text(input.remoteToken) : ''

    return {
      kind: input.mode,
      url: text(input.remoteUrl),
      authMode: input.mode === 'cloud' ? 'oauth' : (input.remoteAuthMode ?? 'token'),
      ...(token && { token }),
      ...(input.mode === 'cloud' && text(input.cloudOrg) && { org: text(input.cloudOrg) }),
      ...(input.mode === 'cloud' && text(input.cloudName) && { label: text(input.cloudName) })
    }
  }

  return { kind: 'local' }
}
