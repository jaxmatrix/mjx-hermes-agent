import { describe, expect, it } from 'vitest'

import {
  CONNECTION_SEARCH_THRESHOLD,
  connectionEndpointLabel,
  connectionSearchMatches,
  sameBackendHints,
  sortConnectionsForDisplay
} from '@/lib/connection-display'
import type { ConnectionView } from '@/store/connections'

function view(patch: Partial<ConnectionView>): ConnectionView {
  return {
    hasSshKey: false,
    hasSshPassphrase: false,
    hasSshPassword: false,
    hasToken: false,
    headerNames: [],
    id: patch.label ?? 'a',
    kind: 'remote',
    label: 'A',
    legacy: false,
    order: 0,
    ...patch
  }
}

describe('sortConnectionsForDisplay', () => {
  it('puts local first, then labels case-insensitively with numeric order', () => {
    const sorted = sortConnectionsForDisplay([
      view({ label: 'box 10' }),
      view({ label: 'Box 2' }),
      view({ kind: 'local', label: 'This device' }),
      view({ label: 'alpha' })
    ])

    expect(sorted.map(row => row.label)).toEqual(['This device', 'alpha', 'Box 2', 'box 10'])
  })

  it('does not mutate the registry order', () => {
    const rows = [view({ label: 'b', order: 0 }), view({ label: 'a', order: 1 })]

    sortConnectionsForDisplay(rows)

    expect(rows.map(row => row.label)).toEqual(['b', 'a'])
  })
})

describe('connectionSearchMatches', () => {
  it('matches labels, transport details and kind, accent-insensitively', () => {
    const row = view({ host: 'studio.local', kind: 'ssh', label: 'Stüdio', user: 'me' })

    expect(connectionSearchMatches(row, 'studio')).toBe(true)
    expect(connectionSearchMatches(row, 'STUDIO')).toBe(true)
    expect(connectionSearchMatches(row, 'me')).toBe(true)
    expect(connectionSearchMatches(row, 'ssh')).toBe(true)
    expect(connectionSearchMatches(row, '   ')).toBe(true)
    expect(connectionSearchMatches(row, 'laptop')).toBe(false)
  })

  it('appears only once a list is long enough to need it', () => {
    expect(CONNECTION_SEARCH_THRESHOLD).toBe(8)
  })
})

describe('connectionEndpointLabel', () => {
  // The rule desktop states as a test name: technical endpoints on demand,
  // WITHOUT exposing secrets.
  it('never renders userinfo from a URL', () => {
    const row = view({ kind: 'remote', url: 'https://alice:hunter2@gw.example.com/hermes' })

    const label = connectionEndpointLabel(row) ?? ''

    expect(label).toBe('gw.example.com/hermes')
    expect(label).not.toContain('hunter2')
    expect(label).not.toContain('alice')
  })

  it('renders an ssh target and omits the default port', () => {
    expect(connectionEndpointLabel(view({ host: 'box', kind: 'ssh', port: 22, user: 'me' }))).toBe('me@box')
    expect(connectionEndpointLabel(view({ host: 'box', kind: 'ssh', port: 2222, user: 'me' }))).toBe('me@box:2222')
  })

  it('has nothing to show for a local source', () => {
    expect(connectionEndpointLabel(view({ kind: 'local' }))).toBeNull()
  })
})

describe('sameBackendHints', () => {
  it('hints only the LATER rows sharing an install id', () => {
    const hints = sameBackendHints({ byIp: 'same', byName: 'same', other: 'different', unknown: undefined })

    // The first row is not accused of duplicating anything.
    expect(hints.byIp).toBeUndefined()
    expect(hints.byName).toBe('byIp')
    expect(hints.other).toBeUndefined()
    expect(hints.unknown).toBeUndefined()
  })
})
