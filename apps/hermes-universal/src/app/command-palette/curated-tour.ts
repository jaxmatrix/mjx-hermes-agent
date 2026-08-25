/**
 * THE CURATED TOUR — the walkthrough the ⌘K palette runs (MJXHRM-473).
 *
 * `lib/tour` is generic: the agent authors its own steps, and so can a plugin.
 * This is the one Hermes ships, and it is deliberately short — four stops on
 * the chrome a first-run user has to find before anything else works.
 *
 * Every selector here is a `data-tour` handle, never a positional path: a
 * nth-child selector survives exactly until the next re-render, and the engine
 * REJECTS a tour whose selectors do not match rather than starting a broken one
 * (`curated-tour.test.ts` asserts the handles still exist).
 *
 * The last step names no element on purpose — it is about the palette the user
 * just launched this from, which is gone by the time the tour is on screen.
 */

import type { Translations } from '@/i18n/types'

/** The steps, in order, resolved against the active locale. */
export function curatedTourSteps(t: Translations): { selector?: string; text: string; title: string }[] {
  const copy = t.commandCenter.tour.steps

  return [
    { selector: '[data-tour="sidebar"]', text: copy.sidebar.text, title: copy.sidebar.title },
    { selector: '[data-tour="composer"]', text: copy.composer.text, title: copy.composer.title },
    { selector: '[data-tour="statusbar"]', text: copy.statusbar.text, title: copy.statusbar.title },
    { text: copy.palette.text, title: copy.palette.title }
  ]
}

/**
 * Wait for the command palette to actually leave the DOM.
 *
 * The palette row that starts the tour runs BEFORE the dialog closes, and the
 * close is animated (`data-[state=closed]:animate-out`, ~150ms) — so without
 * this the first spotlight paints underneath a dialog that is still fading out,
 * which reads as a glitch rather than as a tour starting.
 *
 * Bounded rather than event-driven: this is cosmetic timing, and a palette that
 * somehow never unmounts must not swallow the tour with it. It watches the
 * palette's own `data-tour` handle, so the two cannot drift apart.
 */
async function afterPaletteCloses(): Promise<void> {
  for (let attempt = 0; attempt < 40 && document.querySelector('[data-tour="command-palette"]'); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

/**
 * Run the curated tour. Dynamic import on purpose — it pulls driver.js and two
 * stylesheets, which `src/entry-graph.test.ts` forbids on the boot graph.
 */
export async function startCuratedTour(t: Translations): Promise<void> {
  const { startTour } = await import('@/lib/tour')

  await afterPaletteCloses()
  await startTour(curatedTourSteps(t))
}
