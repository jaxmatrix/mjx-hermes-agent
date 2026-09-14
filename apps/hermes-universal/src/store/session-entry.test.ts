/**
 * MJXHRM-452 — `@/store/session` must survive being the ENTRY of a module graph.
 *
 * `store/session-states.ts` subscribes to `$activeStoredSessionId` at module
 * scope. That is safe only while nothing session.ts imports can reach
 * session-states before session.ts has finished initializing its own atoms.
 * MJXHRM-472 broke exactly that: `store/event-router` (imported by session.ts)
 * gained a static edge to `store/pane-focus` → `store/review` →
 * `store/coding-status` → `store/workspace-events` → `store/session-states`,
 * and every test file that reached `@/store/session` first died at import with
 * "Cannot read properties of undefined (reading 'listen')" — the whole suite,
 * not one case.
 *
 * The property is import order, so this file must import `@/store/session`
 * FIRST and touch nothing else. Any future static store edge that re-closes the
 * cycle turns it red.
 */

import { describe, expect, it } from 'vitest'

// `vitest` above is inert; `@/store/session` must stay the first APP module
// this file loads, or the property under test is not exercised at all.
import { $activeStoredSessionId, $sessions } from '@/store/session'

describe('store/session as a module-graph entry', () => {
  it('initializes its atoms even when nothing else is loaded first', () => {
    expect(typeof $activeStoredSessionId.listen).toBe('function')
    expect($sessions.get()).toEqual([])
  })
})
