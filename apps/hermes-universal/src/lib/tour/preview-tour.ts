import { actInGuest } from '@/lib/browser-act/actor'
import { $browserState, $browserSupported } from '@/store/browser'

import type { TourTarget } from './collect-targets'
import type { TourAction, TourResult, TourStep } from './engine'

/**
 * `tour` with `surface: 'preview'` — the branch MJXHRM-473 left refusing.
 *
 * It runs in the GUEST, not against the app chrome, which is the whole point:
 * a tour that highlighted Hermes' own UI while the agent believed it was
 * pointing at a web page would be a wrong answer, and 473 chose a refusal over
 * that.
 *
 * It rides the ACT engine's annotation overlay rather than injecting driver.js
 * into the guest. A guest tour is a highlight-and-label walk, which is exactly
 * what `pin` already draws — bound to elements so it rides scrolls and reflows —
 * and the engine is already injected for `drive_preview`. Injecting a second
 * engine (driver.js is an ES module, so it would need its own IIFE build) would
 * be a second overlay implementation and a second thing to keep off the boot
 * path, for the same visible result.
 *
 * ponytail: annotation-overlay tour. The ceiling is driver.js's popover chrome —
 * arrows, a Next button inside the page. Upgrade path is an IIFE build of
 * driver.js injected the way `engine.js` is.
 */

interface PreviewTourState {
  steps: TourStep[]
  index: number
}

let live: null | PreviewTourState = null

const NO_GUEST =
  'There is no page open in the in-app browser, so there is nothing to tour. ' +
  'Open one with open_preview first.'

export async function runPreviewTour(action: TourAction): Promise<TourResult> {
  if (!$browserSupported.get() || !$browserState.get().url) {
    return { error: NO_GUEST, success: false }
  }

  switch (action.kind) {
    case 'next':
      return step(1)

    case 'prev':
      return step(-1)

    case 'show':
      return show(action)

    case 'start': {
      const steps = (action.steps ?? []).filter(candidate => candidate.selector)

      if (!steps.length) {
        return { error: 'A preview tour needs at least one step with a selector.', success: false }
      }

      live = { index: clamp(action.startAt ?? 0, steps.length), steps }

      return show(live.steps[live.index])
    }

    case 'stop':
      live = null
      await actInGuest({ action: 'unpin' })

      return { action: 'stop', success: true, ...page() }

    case 'targets':
    default:
      return targets()
  }
}

function clamp(value: number, length: number): number {
  return Math.min(Math.max(Math.floor(value) || 0, 0), Math.max(length - 1, 0))
}

function page(): { title: string; url: string } {
  const state = $browserState.get()

  return { title: state.title, url: state.url }
}

async function targets(): Promise<TourResult> {
  // The engine's own `targets` verb, not `elements`: a tour target carries a
  // rect and a selector, and paying for a rect on every drive inventory to
  // share one code path would be the wrong trade.
  const result = (await actInGuest({ action: 'targets' })) as { error?: string; success: boolean; targets?: TourTarget[] }

  if (!result.success) {
    return { error: result.error ?? 'The page did not answer.', success: false }
  }

  return { action: 'targets', success: true, targets: result.targets ?? [], ...page() }
}

async function show(step: TourStep): Promise<TourResult> {
  if (!step?.selector) {
    return { error: 'A preview tour step needs a selector.', success: false }
  }

  // One mark at a time: a walk, not an accumulation.
  await actInGuest({ action: 'unpin' })

  const result = await actInGuest({
    action: 'pin',
    selector: step.selector,
    text: step.title ? `${step.title}${step.text ? ' — ' + step.text : ''}` : step.text
  })

  if (!result.success) {
    return { error: result.error ?? `Nothing on the page matches ${step.selector}.`, success: false }
  }

  return {
    action: 'show',
    activeStep: live ? live.index : 0,
    steps: live?.steps.length,
    success: true,
    ...page()
  }
}

async function step(delta: number): Promise<TourResult> {
  if (!live) {
    return { error: 'No preview tour is running.', success: false }
  }

  const next = live.index + delta

  if (next >= live.steps.length) {
    live = null
    await actInGuest({ action: 'unpin' })

    return { action: 'next', done: true, success: true, ...page() }
  }

  live.index = clamp(next, live.steps.length)

  return show(live.steps[live.index])
}

/** Test seam. */
export function __resetPreviewTour(): void {
  live = null
}
