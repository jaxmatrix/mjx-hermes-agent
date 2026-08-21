import { latestSessionTodos, type TodoItem } from '@/lib/todos'
import { computed } from '@/store/atom'

import { sessionAliasIds } from './session'
import { $sessionStates } from './session-state-types'

/**
 * Live task progress per session — the "3/7" an inbox-style sidebar card shows.
 *
 * Universal derives todos from the TRANSCRIPT (`lib/todos.ts`), where desktop
 * keeps a `$todosBySession` map fed by live `todo` tool events. That difference
 * is why this file is short: the session slices already hold every message, so
 * the progress is a projection of state universal has rather than a second
 * event pipeline to keep in sync with the first. It also means a card is only
 * ever as fresh as the slice — a session nothing has loaded reports nothing,
 * which is the honest answer for a row whose transcript this window has never
 * seen.
 *
 * Keyed by STORED session id and claimed under every lineage alias, exactly like
 * `$sessionDotStateById`: auto-compression rotates the id, and a sidebar row can
 * be holding either tip.
 */

/** Are any items still outstanding? A finished list is not "in progress". */
export const todoListActive = (todos: readonly TodoItem[]): boolean =>
  todos.some(todo => todo.status === 'pending' || todo.status === 'in_progress')

/** Rendered "done/total" for one list, or null when there is nothing to show.
 *
 *  CANCELLED items count toward neither side: a plan the agent abandoned three
 *  items into should read 4/4 when the rest land, not 4/7 forever. */
export function todoProgressLabel(todos: readonly TodoItem[]): null | string {
  const counted = todos.filter(todo => todo.status !== 'cancelled')

  if (counted.length === 0) {
    return null
  }

  return `${counted.filter(todo => todo.status === 'completed').length}/${counted.length}`
}

/** Stored session id (and every alias) → "done/total". */
export const $todoProgressBySession = computed([$sessionStates], states => {
  const next: Record<string, string> = {}

  for (const state of Object.values(states)) {
    const progress = todoProgressLabel(latestSessionTodos(state.messages) ?? [])

    if (!progress) {
      continue
    }

    for (const alias of sessionAliasIds(state.storedSessionId)) {
      next[alias] = progress
    }
  }

  return next
})
