import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  $subagentsBySession,
  allSubagents,
  buildSubagentTree,
  clearSessionSubagents,
  upsertSubagent
} from './subagents'

const SID = 's1'

describe('subagents reducer', () => {
  beforeEach(() => $subagentsBySession.set({}))
  afterEach(() => $subagentsBySession.set({}))

  it('builds a parent/child tree from spawn events', () => {
    upsertSubagent(SID, { subagent_id: 'a', parent_id: null, goal: 'root', status: 'running' }, true, 'subagent.start')
    upsertSubagent(SID, { subagent_id: 'b', parent_id: 'a', goal: 'child', status: 'running' }, true, 'subagent.start')

    const tree = buildSubagentTree(allSubagents($subagentsBySession.get()))
    expect(tree).toHaveLength(1)
    expect(tree[0].goal).toBe('root')
    expect(tree[0].children.map(c => c.goal)).toEqual(['child'])
  })

  it('does not create an entry for a progress event with an unknown id', () => {
    upsertSubagent(SID, { subagent_id: 'ghost', status: 'running' }, false, 'subagent.progress')
    expect(allSubagents($subagentsBySession.get())).toHaveLength(0)
  })

  it('freezes a subagent once it reaches a terminal status', () => {
    upsertSubagent(SID, { subagent_id: 'a', goal: 'root', status: 'running' }, true, 'subagent.start')
    upsertSubagent(SID, { subagent_id: 'a', status: 'completed', summary: 'done' }, false, 'subagent.complete')
    // A late progress event must not revive it.
    upsertSubagent(SID, { subagent_id: 'a', status: 'running' }, false, 'subagent.progress')

    const [only] = allSubagents($subagentsBySession.get())
    expect(only.status).toBe('completed')
  })

  it('accumulates the stream tail from progress/tool events', () => {
    upsertSubagent(SID, { subagent_id: 'a', goal: 'root', status: 'running' }, true, 'subagent.start')
    upsertSubagent(SID, { subagent_id: 'a', text: 'reading files', status: 'running' }, false, 'subagent.progress')
    const [node] = allSubagents($subagentsBySession.get())
    expect(node.stream.at(-1)?.text).toBe('reading files')
  })

  it('clears one session', () => {
    upsertSubagent(SID, { subagent_id: 'a', goal: 'root', status: 'running' }, true, 'subagent.start')
    clearSessionSubagents(SID)
    expect(allSubagents($subagentsBySession.get())).toHaveLength(0)
  })
})
