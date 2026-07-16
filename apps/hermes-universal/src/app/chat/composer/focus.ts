/**
 * Composer focus helpers, ported (trimmed) from the desktop composer's focus.ts.
 * Universal has a single "main" composer, so the multi-scope insert/submit/voice
 * event bus is dropped; we keep the active-target marker and the focus/blur
 * primitives the status stack + input use.
 */
import { RICH_INPUT_SLOT } from './rich-editor'

/** Composer routing key. Universal has a single hard-coded `'main'` scope. */
export type ComposerTarget = 'edit' | 'main' | (string & {})

let activeTarget: ComposerTarget = 'main'

export const markActiveComposer = (target: ComposerTarget) => {
  activeTarget = target
}

/** The composer that last held focus. */
export const getActiveComposer = (): ComposerTarget => activeTarget

/**
 * Focus a composer input across React commit + browser focus restore. The
 * triple-call survives sync mount, a just-committed content swap (rAF), and a
 * browser focus reclaim from an external click target (0ms).
 */
export const focusComposerInput = (el: HTMLElement | null) => {
  if (!el) {
    return
  }

  const focus = () => el.focus({ preventScroll: true })

  focus()
  window.requestAnimationFrame(focus)
  window.setTimeout(focus, 0)
}

/** Drop focus from the main composer input (status-stack chrome, sidebar, etc.). */
export const blurComposerInput = () => {
  const el = document.querySelector(`[data-slot="${RICH_INPUT_SLOT}"]`) as HTMLElement | null

  if (el && document.activeElement === el) {
    el.blur()
  }
}
