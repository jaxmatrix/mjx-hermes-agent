/**
 * MJXHRM-452 — live task progress per session, the "3/7" an inbox-style sidebar
 * card shows.
 *
 * Universal derives todos from the TRANSCRIPT where desktop keeps a live map fed
 * by `todo` tool events, so this is a projection of state universal already
 * holds rather than a second pipeline. The rules that matter: cancelled items
 * count toward neither side of the fraction, a session with no list contributes
 * nothing at all, and the progress is claimed under every lineage alias so a
 * sidebar row holding either tip of a compacted conversation finds it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/store/gateway', async () => {
  const { atom } = await import('@/store/atom')

  return {
    $gatewayState: atom('open'),
    addGatewayEventListener: () => () => {},
    getGatewayClient: () => null,
    requestGateway: vi.fn()
  }
})

import type { TodoItem, TodoStatus } from '@/lib/todos'

import { $sessions } from './session'
import { $sessionStates, emptySessionState } from './session-state-types'
import { $todoProgressBySession, todoListActive, todoProgressLabel } from './todos'

const todo = (id: string, status: TodoStatus): TodoItem => ({ content: `task ${id}`, id, status })

/** A transcript whose todo-tool parts carry lists — `lib/todos` reads
 *  `tool-call` parts named `todo`, live ones carrying `todos`.
 *
 *  Two stale lists surround the real one, one in an EARLIER message and one in
 *  an earlier PART of the same message, so the fixture exercises both halves of
 *  "the last list wins" — the message walk and the per-message part scan. */
const stale = (id: string) => ({ toolName: 'todo', todos: [todo(id, 'pending')], type: 'tool-call' })

const transcriptWith = (todos: TodoItem[]) =>
  [
    { parts: [stale('older-message')] },
    { parts: [stale('older-part'), { toolName: 'todo', todos, type: 'tool-call' }] }
  ] as never

beforeEach(() => {
  $sessions.set([])
  $sessionStates.set({})
})

describe('todoProgressLabel', () => {
  it('counts completed against the total', () => {
    expect(todoProgressLabel([todo('a', 'completed'), todo('b', 'pending'), todo('c', 'pending')])).toBe('1/3')
  })

  it('excludes cancelled items from BOTH sides of the fraction', () => {
    // Seeded to disagree with a plain length: five items, two abandoned. A plan
    // the agent gave up on three items in should read 3/3 when the rest land,
    // not 3/5 forever.
    expect(
      todoProgressLabel([
        todo('a', 'completed'),
        todo('b', 'completed'),
        todo('c', 'completed'),
        todo('d', 'cancelled'),
        todo('e', 'cancelled')
      ])
    ).toBe('3/3')
  })

  it('has nothing to show for an empty or wholly cancelled list', () => {
    expect(todoProgressLabel([])).toBeNull()
    expect(todoProgressLabel([todo('a', 'cancelled')])).toBeNull()
  })
})

describe('todoListActive', () => {
  it('is false once every item has settled', () => {
    expect(todoListActive([todo('a', 'completed'), todo('b', 'cancelled')])).toBe(false)
  })

  it('is true while anything is pending or running', () => {
    expect(todoListActive([todo('a', 'completed'), todo('b', 'in_progress')])).toBe(true)
  })
})

describe('$todoProgressBySession', () => {
  it('takes the LAST list in the transcript and claims it under every alias', () => {
    $sessionStates.set({
      'rt-1': {
        ...emptySessionState('tip'),
        messages: transcriptWith([todo('a', 'completed'), todo('b', 'pending')]),
        storedSessionId: 'tip'
      }
    })
    $sessions.set([{ _lineage_root_id: 'root', id: 'tip' } as never])

    // The earlier list in the fixture would read 0/1 — only the last one wins.
    expect($todoProgressBySession.get()).toEqual({ tip: '1/2' })
  })

  it('reports nothing for a session whose transcript has no list', () => {
    $sessionStates.set({ 'rt-1': { ...emptySessionState('plain'), storedSessionId: 'plain' } })

    expect($todoProgressBySession.get()).toEqual({})
  })
})
