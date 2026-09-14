import { beforeEach, describe, expect, it, vi } from 'vitest'

const { api } = vi.hoisted(() => ({ api: vi.fn() }))

vi.mock('@/lib/api', () => ({ api, setConnectionBaseResolver: vi.fn() }))

import type { SessionInfo } from '@/types/hermes'

import { $connectionsRegistry, type ConnectionView, type RegistryView } from './connections'
import {
  connectionIdForSession,
  fetchRegistrySessionRows,
  forgetSessionSources,
  mergeSourceSessionWindow,
  REMOTE_SESSION_PAGE_LIMIT,
  type SourceSessionRow,
  spliceRegistrySessionRows
} from './session-sources'

function source(patch: Partial<ConnectionView>): ConnectionView {
  return {
    hasSshKey: false,
    hasSshPassphrase: false,
    hasSshPassword: false,
    hasToken: false,
    headerNames: [],
    id: 'a',
    kind: 'remote',
    label: 'A',
    legacy: false,
    order: 0,
    url: 'https://a.test',
    ...patch
  }
}

function registry(connections: ConnectionView[]): RegistryView {
  return {
    connections,
    keyringAvailable: true,
    lastUsed: 'a',
    launchMode: 'last-used',
    localSupported: true,
    primary: 'a',
    readOnly: false,
    version: 2
  }
}

const session = (id: string, started = 1): SessionInfo => ({ ended_at: null, id, started_at: started }) as SessionInfo

const paths = (): string[] => api.mock.calls.map(([request]) => String(request.path))

beforeEach(() => {
  api.mockReset()
  forgetSessionSources()
  $connectionsRegistry.set(registry([source({}), source({ id: 'b', kind: 'ssh', label: 'B', url: 'https://b.test' })]))
})

describe('fetchRegistrySessionRows', () => {
  it('reads a shared host through the aggregator and an ssh backend without a profile', async () => {
    api.mockResolvedValue({ sessions: [session('s1')] })

    await fetchRegistrySessionRows({ limit: 10 })

    const [remote, ssh] = paths()

    expect(remote).toContain('/api/profiles/sessions?')
    expect(remote).toContain('profile=all')
    // An ssh backend serves its OWN state.db — there is no aggregator to ask.
    expect(ssh).toContain('/api/sessions?')
    expect(ssh).not.toContain('profile=')
  })

  it('NEVER sends include_hidden on any path', async () => {
    api.mockResolvedValue({ sessions: [session('s1')] })

    await fetchRegistrySessionRows({ limit: 10 })

    // The backend's default `hidden = 0` filter is what keeps Bot Mode's
    // canonical chats out of this list. This is a hard rule, not a default.
    expect(paths().some(path => path.includes('include_hidden'))).toBe(false)
  })

  it('falls back to the single-profile read when the aggregator 404s', async () => {
    api.mockImplementation(async ({ path }: { path: string }) => {
      if (path.includes('/api/profiles/sessions')) {
        throw new Error('HTTP 404')
      }

      return { sessions: [session('s1')] }
    })

    const rows = await fetchRegistrySessionRows({ limit: 10 })

    expect(rows.every(row => row.connection_id)).toBe(true)
    expect(paths().filter(path => path.includes('/api/sessions?')).length).toBe(2)
  })

  it('tags every row and rewrites no id', async () => {
    api.mockResolvedValue({ sessions: [session('shared')] })

    const rows = await fetchRegistrySessionRows({ limit: 10 })

    expect(rows.map(row => row.id)).toEqual(['shared', 'shared'])
    expect(rows.map(row => row.connection_id).sort()).toEqual(['a', 'b'])
    expect(rows.every(row => row.is_default_profile === false)).toBe(true)
  })

  it('lets a dead source contribute nothing without breaking the rest', async () => {
    api.mockImplementation(async ({ connectionId }: { connectionId: string }) => {
      if (connectionId === 'b') {
        throw new Error('unreachable')
      }

      return { sessions: [session('s1')] }
    })

    const rows = await fetchRegistrySessionRows({ limit: 10 })

    expect(rows).toHaveLength(1)
    expect(rows[0]?.connection_id).toBe('a')
  })

  it('skips the active source, whose rows already arrive through store/session', async () => {
    api.mockResolvedValue({ sessions: [session('s1')] })

    await fetchRegistrySessionRows({ limit: 10 }, 'a')

    expect(api.mock.calls).toHaveLength(1)
  })
})

describe('spliceRegistrySessionRows', () => {
  it('dedupes on the (connection_id, id) PAIR, not the id alone', () => {
    const foreign: SourceSessionRow[] = [
      { ...session('shared', 5), connection_id: 'b' },
      { ...session('shared', 9), connection_id: 'a' }
    ]

    const rows = spliceRegistrySessionRows([session('shared', 3)], foreign, 'a')

    // Two gateways minting the same id stay two rows; the ACTIVE source's copy
    // of its own id wins over the foreign duplicate of it.
    expect(rows).toHaveLength(2)
    expect(rows.filter(row => row.connection_id === 'a')).toHaveLength(1)
    expect(rows.find(row => row.connection_id === 'a')?.started_at).toBe(3)
  })

  it('keeps recency order and remembers which source owns each id', () => {
    const rows = spliceRegistrySessionRows(
      [session('old', 1)],
      [{ ...session('new', 99), connection_id: 'b' }],
      'a'
    )

    expect(rows.map(row => row.id)).toEqual(['new', 'old'])
    expect(connectionIdForSession('new')).toBe('b')
    expect(connectionIdForSession('old')).toBe('a')
    expect(connectionIdForSession('never-seen')).toBeNull()
  })
})

describe('mergeSourceSessionWindow', () => {
  it('splits a window larger than one page so a paged read orders like one read', async () => {
    api.mockResolvedValue({ sessions: [] })

    await mergeSourceSessionWindow([], { limit: REMOTE_SESSION_PAGE_LIMIT * 2 }, 'a')

    // Two pages × one non-active source.
    expect(api.mock.calls).toHaveLength(2)
    expect(paths()[0]).toContain(`limit=${REMOTE_SESSION_PAGE_LIMIT}&offset=0`)
    expect(paths()[1]).toContain(`limit=${REMOTE_SESSION_PAGE_LIMIT}&offset=${REMOTE_SESSION_PAGE_LIMIT}`)
  })
})
