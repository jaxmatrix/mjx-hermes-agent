/**
 * Electron's v1 "connection config": the one connection desktop's Settings →
 * Gateway, first-run form and boot-failure overlay read, test, save and apply.
 *
 * Electron keeps it in `connection.json` and keeps the registry's `primary`
 * pointed at it. Universal has no second document: the config IS a registry
 * row (`./registry-shape`, "THE v1 CONFIG") —
 *
 *  • READ: the row this window is on, which is what Electron's primary is here
 *    (`./connections`); before any, the registry's primary. A target SAVED
 *    through this door and not yet applied is read back instead, because
 *    desktop's sign-in saves, signs in, and re-reads what it saved.
 *  • SAVE ("for next restart"): the row that already points at the target, else
 *    a new one — then the launch lands on it under either launch mode.
 *  • APPLY ("and reconnect"): save, then switch onto it as a click — universal's
 *    two-phase `selectConnection`, which may ask (an SSH passphrase, a login
 *    page; on a phone that login is a one-way door, as for every other click).
 *  • TEST / PROBE: publish nothing and dial nothing.
 *
 * A NAMED profile has no config of its own: see `profileGatewayUnsupported`.
 *
 * Rust holds every credential. A token typed into desktop's form goes into the
 * save and is never read back; nothing here logs or throws an address.
 */

import type {
  DesktopConnectionConfig,
  DesktopConnectionConfigInput,
  DesktopConnectionProbeResult,
  DesktopConnectionTestResult
} from '@/global'
import { ownWords } from '@/lib/error-text'
import type { ConnectionTarget, ConnectionView, RegistryView } from '@/store/connections'

import { registryError, settingsCopy, testSavedRow, testSshTarget, verdictCopy } from './registry'
import { toConnectionConfig, toConnectionTarget } from './registry-shape'

type Bridge = NonNullable<typeof window.hermesDesktop>

// Dynamic: both reach `@/hermes`, and the bridge installs before any store.
const registryStore = () => import('@/store/connections')
const connectionStore = () => import('@/store/connection')

/** The row a save through this door wrote and no apply has landed on yet. */
let savedRowId: null | string = null

export const __testing = {
  reset(): void {
    savedRowId = null
  }
}

const profileKey = (profile: null | string | undefined): string => (profile ?? '').trim()

async function activeRowId(): Promise<null | string> {
  const { $activeConnection, launchSettled } = await import('@/store/active-connection')

  await launchSettled()

  return $activeConnection.get()?.connectionId ?? null
}

async function configRow(view: RegistryView): Promise<ConnectionView | undefined> {
  const byId = (id: null | string) => (id ? view.connections.find(row => row.id === id) : undefined)

  return byId(savedRowId) ?? byId(await activeRowId()) ?? byId(view.primary)
}

/** Whether Rust holds a live session for a gated row. "Could not tell" is not
 *  "connected": the indicator only says what was proven. */
async function oauthConnected(row: ConnectionView | undefined): Promise<boolean> {
  if (!row?.url || (row.kind !== 'cloud' && row.authMode !== 'oauth')) {
    return false
  }

  const { oauthStatus } = await import('@/lib/auth')

  return (await oauthStatus(row.url).catch(() => null))?.signedIn === true
}

async function readConfig(profile?: null | string): Promise<DesktopConnectionConfig> {
  const key = profileKey(profile)

  if (key) {
    return toConnectionConfig(undefined, { profile: key })
  }

  const { refreshConnections } = await registryStore()
  const row = await configRow(await refreshConnections())

  return toConnectionConfig(row, { oauthConnected: await oauthConnected(row) })
}

/**
 * The payload as a target, with the row it already names. Desktop's form cannot
 * say `none`: its `token` with no token, onto a row that asks for none, is the
 * form's default and must not re-stamp (and re-dial) the row.
 */
async function targetOf(
  input: DesktopConnectionConfigInput
): Promise<{ row: ConnectionView | undefined; target: ConnectionTarget }> {
  const { connectionRowFor, refreshConnections } = await registryStore()
  const target = toConnectionTarget(input)
  const row = connectionRowFor(target, await refreshConnections())

  if (
    target.kind === 'remote' &&
    target.authMode === 'token' &&
    !target.token &&
    (row?.authMode ?? 'none') === 'none' &&
    !row?.hasToken
  ) {
    const { authMode: _formDefault, ...rest } = target

    return { row, target: rest }
  }

  return { row, target }
}

/** A named profile: `local` is already true of it, and anything else has
 *  nowhere to be written. */
function refuseProfileScope(input: DesktopConnectionConfigInput): null | string {
  const key = profileKey(input?.profile)

  if (key && input.mode !== 'local') {
    throw new Error(settingsCopy().connections.profileGatewayUnsupported)
  }

  return key || null
}

const typedAddresses = (input: DesktopConnectionConfigInput) => [input?.remoteUrl, input?.sshHost]

async function makeLaunchTarget(connectionId: string): Promise<void> {
  const { setLastUsedConnection, setPrimaryConnection } = await registryStore()

  await setPrimaryConnection(connectionId)
  await setLastUsedConnection(connectionId)
}

/** An unsaved URL, or one whose token was just retyped: what can be proven
 *  without writing anything. The typed token is already the webview's. */
async function testUnsavedRemote(
  base: string,
  input: DesktopConnectionConfigInput,
  token: string
): Promise<DesktopConnectionTestResult> {
  const { probeStatus } = await connectionStore()

  const status = await probeStatus(base).catch(error => {
    throw ownWords(error, verdictCopy('unreachable'))
  })

  if (status.auth_required || input.remoteAuthMode === 'oauth' || input.mode === 'cloud') {
    // The session Rust holds mints a socket ticket, or it is not a session.
    const { mintWsTicket } = await import('@/lib/auth')

    await mintWsTicket(base).catch(() => {
      throw new Error(verdictCopy('auth-required'))
    })
  } else if (token) {
    const { httpRequest } = await import('@/transport/http')

    const answer = await httpRequest('GET', `${base}/api/profiles`, {
      headers: { 'X-Hermes-Session-Token': token },
      timeoutMs: 8_000
    }).catch(() => {
      throw new Error(verdictCopy('unreachable'))
    })

    if (answer.status === 401 || answer.status === 403) {
      throw new Error(verdictCopy('credential-rejected'))
    }

    if (answer.status < 200 || answer.status >= 300) {
      throw new Error(verdictCopy('unreachable'))
    }
  }

  return { baseUrl: base, ok: true, reachable: true, version: status.version ?? null }
}

export const connectionConfigBridge: Pick<
  Bridge,
  | 'applyConnectionConfig'
  | 'getConnectionConfig'
  | 'getSecretStorageEncryption'
  | 'oauthLoginConnectionConfig'
  | 'oauthLogoutConnectionConfig'
  | 'probeConnectionConfig'
  | 'saveConnectionConfig'
  | 'setSecretStorageEncryption'
  | 'testConnectionConfig'
> = {
  getConnectionConfig: profile => readConfig(profile),

  saveConnectionConfig: async payload => {
    const profile = refuseProfileScope(payload)

    if (profile) {
      return readConfig(profile)
    }

    const { saveConnectionTarget } = await registryStore()
    const { target } = await targetOf(payload)

    try {
      const connectionId = await saveConnectionTarget(target)

      await makeLaunchTarget(connectionId)
      savedRowId = connectionId
    } catch (error) {
      throw registryError(error, settingsCopy().gateway.saveFailed, typedAddresses(payload))
    }

    return readConfig()
  },

  applyConnectionConfig: async payload => {
    const profile = refuseProfileScope(payload)

    if (profile) {
      return readConfig(profile)
    }

    const { applyConnection } = await registryStore()
    const { target } = await targetOf(payload)

    try {
      // A person pressed it: the switch may ask.
      const connectionId = await applyConnection(target, { allowInteractive: true })

      savedRowId = null
      // Swallowed: the window is already there, and a list that cannot be
      // written must not turn a landed switch into a failed one.
      await makeLaunchTarget(connectionId).catch(() => {})
    } catch (error) {
      throw registryError(error, settingsCopy().gateway.applyFailed, typedAddresses(payload))
    }

    return readConfig()
  },

  testConnectionConfig: async payload => {
    const { row, target } = await targetOf(payload)

    if (target.kind === 'ssh') {
      return testSshTarget(
        {
          host: target.host ?? '',
          keyPath: target.keyPath,
          port: target.port,
          remoteHermesPath: target.remoteHermesPath,
          user: target.user
        },
        row
      )
    }

    if (target.kind === 'local') {
      const { localBackendStatus } = await import('@/store/local-backend')
      const running = (await localBackendStatus().catch(() => null))?.running === true

      return running
        ? { ok: true, reachable: true }
        : { error: settingsCopy().connections.localNotRunning, ok: false, reachable: false }
    }

    const token = target.token ?? ''

    // Electron's remote test REJECTS on failure; its callers print the message.
    if (row && !token) {
      const result = await testSavedRow(row).catch(error => {
        throw registryError(error, verdictCopy('unreachable'))
      })

      if (!result.ok) {
        throw new Error(result.error ?? verdictCopy('unreachable'))
      }

      return result
    }

    const { normalizeBaseUrl } = await connectionStore()

    return testUnsavedRemote(normalizeBaseUrl(target.url ?? ''), payload, token)
  },

  probeConnectionConfig: async remoteUrl => {
    const [{ normalizeBaseUrl, probeStatus }, { fetchAuthProviders }] = await Promise.all([
      connectionStore(),
      import('@/lib/auth')
    ])

    const baseUrl = normalizeBaseUrl(String(remoteUrl ?? ''))

    const unknown: DesktopConnectionProbeResult = {
      authMode: 'unknown',
      baseUrl,
      error: null,
      providers: [],
      reachable: false,
      version: null
    }

    let status

    try {
      status = await probeStatus(baseUrl)
    } catch (error) {
      // Never rejects: a half-typed URL is "can't tell yet".
      return { ...unknown, error: ownWords(error, verdictCopy('unreachable')).message }
    }

    const gated = status.auth_required === true
    const providers = gated ? await fetchAuthProviders(baseUrl).catch(() => []) : []

    return {
      ...unknown,
      authMode: gated ? 'oauth' : 'token',
      providers: providers
        .filter(provider => provider?.name)
        .map(provider => ({
          displayName: provider.display_name || provider.name,
          name: provider.name,
          supportsPassword: provider.supports_password === true
        })),
      reachable: true,
      version: typeof status.version === 'string' ? status.version : null
    }
  },

  oauthLoginConnectionConfig: async remoteUrl => {
    const [{ authenticate, normalizeBaseUrl }, { connectionRowFor, refreshConnections }, { oauthStatus }] =
      await Promise.all([connectionStore(), registryStore(), import('@/lib/auth')])

    const baseUrl = normalizeBaseUrl(String(remoteUrl ?? ''))
    // The row being signed in to rides the phone's resume marker, so the reload
    // that follows the login page lands on it (`beginOAuthLogin`).
    const row = connectionRowFor({ kind: 'remote', url: baseUrl }, await refreshConnections())

    try {
      await authenticate({ allowInteractive: true, connectionId: row?.id, url: baseUrl })
    } catch (error) {
      throw ownWords(error, settingsCopy().gateway.signInFailed)
    }

    const connected = (await oauthStatus(baseUrl).catch(() => null))?.signedIn === true

    return { baseUrl, connected, ok: true }
  },

  oauthLogoutConnectionConfig: async remoteUrl => {
    const [{ normalizeBaseUrl }, { oauthLogout, oauthStatus }] = await Promise.all([
      connectionStore(),
      import('@/lib/auth')
    ])

    const baseUrl = normalizeBaseUrl(String(remoteUrl ?? ''))

    await oauthLogout(baseUrl).catch(error => {
      throw ownWords(error, settingsCopy().gateway.signOutFailed)
    })

    // What is still live, by the same probe the indicator reads.
    return { connected: (await oauthStatus(baseUrl).catch(() => null))?.signedIn === true, ok: true }
  },

  // Electron's toggle chooses between the OS keychain and an obfuscated file.
  // Universal has one store — Rust's, the OS keychain — so the switch reports
  // where secrets already are, and the only change it could make is refused.
  getSecretStorageEncryption: async () => ({
    on: (await (await registryStore()).refreshConnections()).keyringAvailable
  }),

  setSecretStorageEncryption: async on => {
    const available = (await (await registryStore()).refreshConnections()).keyringAvailable

    if (on === available) {
      return { on: available }
    }

    const copy = settingsCopy().connections

    throw new Error(available ? copy.secretsAlwaysStored : copy.noKeyring)
  }
}
