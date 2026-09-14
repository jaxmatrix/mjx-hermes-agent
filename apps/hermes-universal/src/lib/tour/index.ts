/**
 * TOURS — highlight-and-narrate walkthroughs of the app (MJXHRM-473).
 *
 * Two consumers, one engine:
 *
 * - The `tour` agent tool, via the gateway (see `store/tour-bridge.ts`).
 * - Your own curated tours, via this module:
 *
 * ```ts
 * import { startTour, showTourStep, stopTour } from '@/lib/tour'
 *
 * startTour([
 *   { selector: '[data-tour="composer"]', title: 'Composer', text: 'Type here.' },
 *   { selector: '[data-tour="files"]', title: 'Files', text: 'Your project.' }
 * ])
 * ```
 *
 * Tours run against whatever is in the DOM — mark elements with `data-tour="…"`
 * to give them durable handles (see `collectTourTargets`, which reports those
 * first and flags every selector as stable or positional).
 *
 * Import this module DYNAMICALLY. It pulls driver.js and two stylesheets, and
 * `src/entry-graph.test.ts` fails if any of that reaches the boot graph.
 */

export { collectTourTargets, type TourTarget } from './collect-targets'
export type { TourAction, TourHost, TourResult, TourStep } from './engine'
export {
  isTourActive,
  listTourTargets,
  nextTourStep,
  previousTourStep,
  runTour,
  showTourStep,
  startTour,
  stopTour,
  type TourSurface
} from './run-tour'
