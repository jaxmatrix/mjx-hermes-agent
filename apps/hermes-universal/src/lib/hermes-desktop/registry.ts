/**
 * `hermesDesktop.connections`: Electron's named-source registry, answered from
 * Rust's (`connections_*`) through universal's registry store. The shapes, and
 * what a save from desktop's form may and may not touch, are
 * `./registry-shape`'s — read that first.
 *
 * Every write goes through `store/connections`, so the Rust view, desktop's
 * atom and the window's own source move together, and a save that re-points
 * the row the app is on re-homes every window exactly as universal's own
 * editor does.
 *
 * `updateManaged` is absent (`preload-drift.test.ts`): Electron's transactional
 * SSH update drains and restores serves it owns, and Rust has no such engine.
 * Desktop's Managed updates section feature-detects it and stays hidden.
 */

import type { DesktopConnectionTestResult } from '@/global'
import { TRANSLATIONS } from '@/i18n/catalog'
import { getRuntimeI18nLocale } from '@/i18n/runtime'
import type { ConnectionView, ProbeVerdict } from '@/store/connections'

import { toDesktopConnection, toDesktopRegistry, toSaveInput } from './registry-shape'

type Bridge = NonNullable<typeof window.hermesDesktop>
type Registry = Bridge['connections']

// Dynamic, all three: they reach `@/hermes`, and the bridge installs before any
// store evaluates (`./install`).
const registryStore = () => import('@/store/connections')

/** The registry's own refusals: a name, a duplicate, a full list, no keyring.
 *  Rust words them for a person and they name nothing but what was typed. */
const SPOKEN_KINDS = new Set([
  'duplicate-label',
  'duplicate-target',
  'future-version',
  'invalid-input',
  'keyring-unavailable',
  'local-not-removable',
  'local-unsupported',
  'not-found',
  'registry-full',
  'reserved-id'
])

/**
 * A rejected registry command as an `Error` desktop's toasts can read. A kind
 * outside the list (a failed write quotes an OS error) becomes `copy`, and so
 * does a message that quotes an address back (`… is not a valid URL`).
 */
export function registryError(error: unknown, copy: string, typed: (string | undefined)[] = []): Error {
  if (error instanceof Error) {
    return error
  }

  const { kind, message } = (error ?? {}) as { kind?: unknown; message?: unknown }

  if (typeof kind !== 'string' || typeof message !== 'string' || !SPOKEN_KINDS.has(kind)) {
    return new Error(copy)
  }

  const quoted = typed.some(value => Boolean(value?.trim()) && message.includes(value!.trim()))

  return new Error(quoted ? copy : message)
}

const SSH_TEST_KINDS = new Set<NonNullable<DesktopConnectionTestResult['sshError']>>([
  'auth-failed',
  'hermes-not-found',
  'host-key-changed',
  'timeout',
  'unreachable',
  'unsupported-platform',
  'update-required'
])

/** The catalogue, typed: a `translateNow` path is a string tsc cannot check. */
export const settingsCopy = () => TRANSLATIONS[getRuntimeI18nLocale()].settings

function sshFailure(error: unknown): DesktopConnectionTestResult {
  const g = settingsCopy().gateway
  const raw = (error as { kind?: unknown } | null)?.kind
  const sshError = SSH_TEST_KINDS.has(raw as never) ? (raw as DesktopConnectionTestResult['sshError']) : 'unknown'

  // Copy by kind: Rust's own message names the host.
  const copy = {
    'auth-failed': g.sshErrAuth,
    'hermes-not-found': g.sshErrNotInstalled,
    'host-key-changed': g.sshErrHostKey,
    timeout: g.sshErrTimeout,
    unknown: g.sshErrUnknown,
    unreachable: g.sshErrUnreachable,
    'unsupported-platform': g.sshErrPlatform,
    'update-required': g.sshErrUpdateRequired
  }

  return { error: copy[sshError ?? 'unknown'], ok: false, reachable: false, sshError }
}

export interface SshTestTarget {
  host: string
  keyPath?: string
  port?: null | number
  remoteHermesPath?: string
  user?: string
}

/**
 * Rust's throwaway SSH session (`ssh_test`): it authenticates and reads the
 * platform, and touches neither a tunnel nor a running backend. A person
 * pressed Test, so it may ask — the window's prompt dialog answers. A
 * registered row's credentials are read by Rust from that row's own accounts;
 * the pre-registry owner's are the bare ones its dial has always passed.
 */
export async function testSshTarget(target: SshTestTarget, row?: ConnectionView): Promise<DesktopConnectionTestResult> {
  const { attachSshPrompts, newAttemptId, testSshBackend } = await import('@/store/ssh-backend')
  const attemptId = newAttemptId()
  const detach = await attachSshPrompts(attemptId).catch(() => null)

  try {
    const legacy = row?.legacy ? await (await import('@/lib/secure-store')).loadSshSecrets().catch(() => null) : null

    const result = await testSshBackend(attemptId, {
      ...target,
      ...(row && !row.legacy && { connectionId: row.id }),
      ...(legacy && {
        passphrase: legacy.passphrase,
        password: legacy.password,
        privateKeyPem: legacy.privateKeyPem
      }),
      interactive: true
    })

    return result.reachable
      ? { host: result.hostLabel, ok: true, reachable: true, remotePlatform: result.platform }
      : sshFailure(null)
  } catch (error) {
    return sshFailure(error)
  } finally {
    detach?.()
  }
}

export const verdictCopy = (verdict: ProbeVerdict): string => settingsCopy().connections.verdict(verdict)

/** Rust's two-leg probe of a saved URL row, in desktop's words. */
export async function testSavedRow(row: ConnectionView): Promise<DesktopConnectionTestResult> {
  const { testConnection } = await registryStore()
  const result = await testConnection(row.id)

  return result.ok
    ? { baseUrl: row.url, ok: true, reachable: true, version: result.version ?? null }
    : { baseUrl: row.url, error: verdictCopy(result.verdict), ok: false, reachable: false }
}

async function rowOf(id: string): Promise<ConnectionView> {
  const { connectionById, refreshConnections } = await registryStore()
  const key = String(id ?? '')
  const row = connectionById(key) ?? (await refreshConnections()).connections.find(entry => entry.id === key)

  if (!row) {
    // Electron's words, which `store/gateway.ts` also matches on.
    throw new Error(`No connection with id "${key}"`)
  }

  return row
}

/** Desktop's three reasons, from Rust's event. `source` is universal's own
 *  cross-window commit, which `store/connections` applies; desktop has no such
 *  signal and its listeners would only refresh a list the store just set. */
export function changedReason(payload: {
  dialFieldsChanged?: boolean
  reason?: string
}): 'removed' | 'saved' | 'updated' | null {
  switch (payload.reason) {
    case 'removed':
      return 'removed'

    case 'saved':
      // A materially edited row: sockets scoped to it point at the old target.
      return payload.dialFieldsChanged ? 'updated' : 'saved'

    // Nothing moved — desktop's `saved` is exactly "re-read the registry".
    case 'primary':

    case 'launch-mode':
      return 'saved'

    default:
      return null
  }
}

const CHANGED_EVENT = 'hermes://connections-changed'

const registry: Omit<Required<Registry>, 'updateManaged'> = {
  list: async () => toDesktopRegistry(await (await registryStore()).refreshConnections()),

  save: async payload => {
    const { connectionById, saveConnection } = await registryStore()
    const existing = payload?.id ? connectionById(payload.id) : undefined

    const outcome = await saveConnection(toSaveInput(payload, existing)).catch(error => {
      throw registryError(error, settingsCopy().connections.saveFailed, [payload?.url, payload?.host])
    })

    const saved = outcome.registry.connections.find(row => row.id === outcome.connectionId)

    if (!saved) {
      throw new Error(settingsCopy().connections.saveFailed)
    }

    return { connection: toDesktopConnection(saved), ok: true, registry: toDesktopRegistry(outcome.registry) }
  },

  remove: async id => {
    const { removeConnection } = await registryStore()

    const view = await removeConnection(String(id ?? '')).catch(error => {
      throw registryError(error, settingsCopy().connections.removeFailed)
    })

    return { ok: true, registry: toDesktopRegistry(view) }
  },

  setPrimary: async id => {
    const { setPrimaryConnection } = await registryStore()

    const view = await setPrimaryConnection(String(id ?? '')).catch(error => {
      throw registryError(error, settingsCopy().connections.saveFailed)
    })

    return { ok: true, registry: toDesktopRegistry(view) }
  },

  setLaunchMode: async mode => {
    if (mode !== 'last-used' && mode !== 'primary') {
      throw new Error(settingsCopy().connections.saveFailed)
    }

    const { setLaunchMode } = await registryStore()

    const view = await setLaunchMode(mode).catch(error => {
      throw registryError(error, settingsCopy().connections.saveFailed)
    })

    return { ok: true, registry: toDesktopRegistry(view) }
  },

  setLastUsed: async id => {
    const { setLastUsedConnection } = await registryStore()

    const view = await setLastUsedConnection(String(id ?? '')).catch(error => {
      throw registryError(error, settingsCopy().connections.saveFailed)
    })

    return { ok: true, registry: toDesktopRegistry(view) }
  },

  test: async id => {
    const row = await rowOf(id)

    if (row.kind === 'ssh') {
      return testSshTarget(
        {
          host: row.host ?? '',
          keyPath: row.keyPath,
          port: row.port,
          remoteHermesPath: row.remoteHermesPath,
          user: row.user
        },
        row
      )
    }

    if (row.kind === 'local') {
      // Electron starts its child to test it. A test here starts nothing: this
      // device's backend is up, or the answer is that it is not.
      const { localBackendStatus } = await import('@/store/local-backend')
      const running = (await localBackendStatus().catch(() => null))?.running === true

      return running
        ? { ok: true, reachable: true }
        : { error: settingsCopy().connections.localNotRunning, ok: false, reachable: false }
    }

    return testSavedRow(row).catch(error => {
      throw registryError(error, verdictCopy('unreachable'))
    })
  },

  updateAll: async options => {
    const [{ updateSources }, { connectionById }] = await Promise.all([
      import('@/store/connection-updates'),
      registryStore()
    ])

    const rows = await updateSources(options?.excludeIds ?? [])

    return {
      ok: true,
      results: rows.map(row => {
        const base = {
          connectionId: row.connectionId,
          kind: connectionById(row.connectionId)?.kind ?? ('remote' as const),
          label: row.label,
          ok: row.ok,
          skipped: row.skipped,
          ...(row.reason && { reason: row.reason })
        }

        // Rust's text for a source it could not reach quotes the address.
        if (row.reason === 'unreachable') {
          return { ...base, error: verdictCopy('unreachable') }
        }

        // A local or SSH source has no address to post to until it is dialled.
        if (row.reason === 'connect-on-demand') {
          return { ...base, detail: settingsCopy().connections.updateNeedsConnection }
        }

        return { ...base, ...(row.detail && { detail: row.detail }) }
      })
    }
  },

  onChanged: callback => {
    let stopped = false
    let unlisten: (() => void) | undefined

    void import('@tauri-apps/api/event')
      .then(({ listen }) =>
        listen<{ connectionId?: null | string; dialFieldsChanged?: boolean; reason?: string }>(CHANGED_EVENT, event => {
          const reason = changedReason(event.payload ?? {})

          if (reason) {
            callback({ connectionId: event.payload?.connectionId ?? '', reason })
          }
        })
      )
      .then(off => {
        if (stopped) {
          off()
        } else {
          unlisten = off
        }
      })
      // No event bus (plain-browser dev): nothing will ever change under it.
      .catch(() => {})

    return () => {
      stopped = true
      unlisten?.()
    }
  }
}

export const registryBridge: { connections: typeof registry } = { connections: registry }
