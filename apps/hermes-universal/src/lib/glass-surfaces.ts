/**
 * The DOM half of window glass: three flags, two custom properties, one
 * attribute. No atoms, no imports from the store — so it unit-tests in jsdom.
 *
 * There is exactly ONE painter. `styles.css` gives `body` the field colour and
 * the glass block thins that one declaration; the surface TOKENS go transparent
 * so the nested field surfaces (zone > pane > transcript) do not each stack
 * another coat of tint. Anything raised above the field, or that MASKS what is
 * behind it, opts out with `[data-glass-raised]` / `[data-glass-opaque]`.
 */

import { glassActive, glassSurfaceKeep, type TranslucencyState } from './translucency-model'

/** Root attribute set while a compositor material is actually on the window. */
const GLASS_FLAG = 'hermesGlass'
/**
 * Set on EVERY window whose page follows a glass setting, including the ones
 * with no native lever of their own (satellites). A later HUD band can paint the
 * app's field mix off this without any store change.
 */
const GLASS_ON_FLAG = 'hermesGlassOn'
/** Set while the whole window is being faded — text included. */
const CLEAR_FLAG = 'hermesClear'
const SCOPE_ATTR = 'hermesGlassScope'

const KEEP_PROPERTY = '--translucency-glass-keep'
const RAIL_PROPERTY = '--glass-rail-edge'

/** The pane the sidebar scope measures. Absent → the seam falls back to `0px`. */
const RAIL_SELECTOR = '[data-pane-id="sessions"]'

export interface GlassSurfaceOptions {
  /**
   * Whether THIS window's page may thin. False for satellites, which get the
   * tint token and `-on` but never the surface rewrite: the HUD is an
   * output-sized layer surface and the wake indicator is a light, and neither
   * has anything behind it to show.
   */
  glassBacked: boolean
  /** What the window actually carries, per the native outcome — never the ask. */
  effectiveGlass: boolean
}

function root(): HTMLElement | null {
  return typeof document === 'undefined' ? null : document.documentElement
}

/**
 * Write the resolved state onto `<html>`. Synchronous and idempotent: the store
 * calls it once at module init so the first paint is already correct, and once
 * per slider tick during a drag.
 */
export function applyGlassSurfaces(state: TranslucencyState, options: GlassSurfaceOptions): void {
  const element = root()

  if (!element) {
    return
  }

  const active = glassActive(state)
  const glass = active && options.effectiveGlass && options.glassBacked
  const clear = state.mode === 'clear' && state.intensity > 0

  toggle(element, GLASS_FLAG, glass)
  toggle(element, GLASS_ON_FLAG, active)
  toggle(element, CLEAR_FLAG, clear)

  if (glass && state.scope === 'sidebar') {
    element.dataset[SCOPE_ATTR] = state.scope
  } else {
    delete element.dataset[SCOPE_ATTR]
  }

  // The tint rides on every window that follows the setting, satellites
  // included — it is a colour, not a window property.
  if (active) {
    element.style.setProperty(KEEP_PROPERTY, `${glassSurfaceKeep(state.intensity)}%`)
  } else {
    element.style.removeProperty(KEEP_PROPERTY)
  }

  if (glass && state.scope === 'sidebar') {
    startRailTracking()
  } else {
    stopRailTracking()
  }
}

function toggle(element: HTMLElement, flag: string, on: boolean): void {
  if (on) {
    element.dataset[flag] = ''
  } else {
    delete element.dataset[flag]
  }
}

let observer: null | ResizeObserver = null
let tracked: Element | null = null

/**
 * Publish the sessions rail's inner edge so the sidebar scope can draw a hard
 * seam there.
 *
 * The rail is tracked by PANE, not by "the leftmost zone": a user who reorders
 * panes for unrelated reasons should not see the glass seam jump. With no rail
 * on screen the property falls back to `0px`, which makes the whole field
 * opaque — the same answer the desktop app gives.
 *
 * RTL measures from the other edge, because the rail is at `inset-inline-start`
 * and the gradient is written in physical coordinates.
 */
export function startRailTracking(): void {
  if (typeof document === 'undefined' || typeof ResizeObserver === 'undefined') {
    return
  }

  if (!observer) {
    observer = new ResizeObserver(() => measureRail())
    window.addEventListener('resize', measureRail)
  }

  measureRail()
}

export function stopRailTracking(): void {
  if (!observer) {
    return
  }

  observer.disconnect()
  observer = null
  tracked = null
  window.removeEventListener('resize', measureRail)
  root()?.style.removeProperty(RAIL_PROPERTY)
}

function measureRail(): void {
  const element = root()

  if (!element || !observer) {
    return
  }

  // Re-acquire when the node is gone or has been detached — a pane that is
  // collapsed and reopened is a different element, and a stale observer would
  // keep reporting the old one's width forever.
  if (!tracked || !tracked.isConnected) {
    tracked = document.querySelector(RAIL_SELECTOR)

    if (tracked) {
      observer.disconnect()
      observer.observe(tracked)
    }
  }

  if (!tracked) {
    element.style.setProperty(RAIL_PROPERTY, '0px')

    return
  }

  const rect = tracked.getBoundingClientRect()
  const rtl = element.dir === 'rtl'
  const edge = rtl ? window.innerWidth - rect.left : rect.right

  element.style.setProperty(RAIL_PROPERTY, `${Math.max(0, Math.round(edge))}px`)
}
