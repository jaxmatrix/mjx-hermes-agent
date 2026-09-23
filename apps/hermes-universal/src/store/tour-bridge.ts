/**
 * Answer the agent's `tour.request` by actually running a tour (MJXHRM-473).
 *
 * The routing for this already existed — `store/agent-read-requests.ts` listens
 * for the frame, parks the blocked tool, and hands whatever a registered driver
 * returns back on `tour.respond`; MJXHRM-472 gave the unregistered case a
 * shaped `{success: false, error}` so the tool would stop telling the model to
 * "open a preview and try again". What did not exist was a driver. This
 * registers one, and the negative default is now the fallback rather than the
 * answer.
 *
 * Same shape as `store/window-below.ts` next door, for the same reasons: the
 * registry holds exactly ONE driver, and the first turn can ask before any
 * component has mounted — so the install happens at boot from `main.tsx`, not
 * from a component effect.
 *
 * driver.js is loaded on FIRST REQUEST, not here: `import('@/lib/tour')` pulls
 * the engine, driver.js and two stylesheets, none of which belong on the boot
 * path. `src/entry-graph.test.ts` is what enforces that.
 */

import type { TourAction, TourStep } from '@/lib/tour'
import { registerTourDriver, type TourRequest } from '@/store/agent-read-requests'
import { ownsPersistedAppState } from '@/store/windows'

/**
 * The tool call → one normalized engine action.
 *
 * `action` defaults to `stop` (desktop's `desktop-bridge.ts` does the same): a
 * frame that names no verb is malformed, and of the six verbs the only one that
 * cannot leave the user staring at a spotlight nobody asked for is the one that
 * clears it. The verb itself is NOT validated here — the engine answers an
 * unknown one with `Unknown tour action: …`, which tells the model what it got
 * wrong, while a silent `stop` would look like the tour ran and did nothing.
 */
function toAction(request: TourRequest): TourAction {
  return {
    kind: (request.action ?? 'stop') as TourAction['kind'],
    selector: request.selector,
    side: request.side as TourStep['side'],
    startAt: request.step_index,
    steps: request.steps as TourStep[] | undefined,
    text: request.text,
    title: request.title
  }
}

/**
 * Install the driver. Idempotent per window; returns the unregister.
 *
 * Registered only by the window that OWNS the app's layout. Every window in the
 * process shares this module and the registry holds one driver, so two windows
 * racing for it would make "which screen gets highlighted" depend on which
 * booted last. `ownsPersistedAppState()` is the right predicate rather than the
 * narrower `isSecondaryWindow()`: a tour navigates routes and reveals panes,
 * and `revealBridgePane` (MJXHRM-472) refuses on exactly the windows this
 * predicate excludes — detached tiles, satellites (HUD / wake indicator) and
 * the Android activity screens. Registering in one of those would answer the
 * agent "highlighted" while every pane step silently did nothing.
 */
export function installTourDriver(): () => void {
  if (!ownsPersistedAppState()) {
    return () => {}
  }

  return registerTourDriver(async request => {
    const { runTour } = await import('@/lib/tour')

    return runTour(toAction(request), request.surface === 'preview' ? 'preview' : 'app')
  })
}
