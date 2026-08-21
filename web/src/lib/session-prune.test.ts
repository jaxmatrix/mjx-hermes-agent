import { describe, expect, it } from 'vitest'

import { formatSessionPruneResult } from './session-prune'

describe('formatSessionPruneResult', () => {
  it('reports open sessions skipped by the prune safety guard', () => {
    expect(formatSessionPruneResult({ removed: 0, skipped_open: 2 })).toBe(
      'Pruned 0 sessions. Skipped 2 open sessions; prune only removes ended sessions.'
    )
  })

  it('keeps the existing success message when nothing was skipped', () => {
    expect(formatSessionPruneResult({ removed: 1, skipped_open: 0 })).toBe('Pruned 1 session')
  })

  it('reports pinned sessions the keep flag spared', () => {
    expect(formatSessionPruneResult({ removed: 3, skipped_open: 0, skipped_pinned: 1 })).toBe(
      'Pruned 3 sessions. Spared 1 pinned session; tick "Also prune pinned sessions" to delete those too.'
    )
  })

  it('reports both reasons in one sentence', () => {
    expect(formatSessionPruneResult({ removed: 0, skipped_open: 1, skipped_pinned: 2 })).toBe(
      'Pruned 0 sessions. Skipped 1 open session; prune only removes ended sessions. ' +
        'Spared 2 pinned sessions; tick "Also prune pinned sessions" to delete those too.'
    )
  })

  it('says nothing about pins when none were spared or the gateway predates the field', () => {
    expect(formatSessionPruneResult({ removed: 2, skipped_open: 0, skipped_pinned: 0 })).toBe('Pruned 2 sessions')
    expect(formatSessionPruneResult({ removed: 2, skipped_open: 0 })).toBe('Pruned 2 sessions')
  })
})
