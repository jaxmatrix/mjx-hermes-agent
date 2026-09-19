/**
 * `-webkit-app-region`, for webviews that do not have it.
 *
 * Desktop moves its frameless window with Chromium's `-webkit-app-region: drag |
 * no-drag`. WebKitGTK, WKWebView and WebView2-under-Tauri ignore the property,
 * and Tauri's own `data-tauri-drag-region` needs an attribute on the element —
 * which would mean editing desktop's files. This is the one lever instead.
 *
 * HOW DESKTOP MARKS A REGION. Only three ways, all found by grepping
 * `app-region` (and pinned by `window-drag.test.ts`, so a resync that adds a
 * fourth fails there instead of at runtime):
 *
 *   - the Tailwind arbitrary-property class `[-webkit-app-region:drag]` /
 *     `[-webkit-app-region:no-drag]`, unprefixed, on ~30 elements;
 *   - the stylesheet rule `button { -webkit-app-region: no-drag }`;
 *   - one inline `WebkitAppRegion: 'no-drag'` on a tab strip WHILE a tab drag is
 *     in flight (`tree-group.tsx`). A press cannot begin mid-drag, so it has no
 *     reading here — and an unknown inline property is not queryable anyway.
 *
 * The class is on the element whether or not the engine understood the rule it
 * names, so the regions are read straight off the DOM with an attribute
 * selector. Walking `document.styleSheets` was the alternative: WebKit drops
 * the unknown declaration from the CSSOM, leaving empty rules to be recognised
 * by their selector text — the same information, through a parser. A build-time
 * scan would add a Vite plugin for a list of two selectors.
 *
 * THE MODEL IS GEOMETRIC, as Chromium's is. Electron unions the rectangles of
 * the `drag` elements and subtracts the `no-drag` ones, in document order,
 * ignoring z-order, ancestry and `pointer-events` — and desktop is written to
 * that: most of its drag bands are `pointer-events-none` strips laid OVER the
 * content, which a press never targets. So the question asked of a press is
 * where it landed, not what it hit: the last marked element in document order
 * whose box holds the point decides.
 *
 * One deliberate softening. In Electron an unmarked control lying over a drag
 * band is simply dead (the OS takes the press); here a press whose target is
 * inside something interactive, or inside a floating layer, always reaches it.
 */

import { getCurrentWindow } from '@tauri-apps/api/window'

import { IS_MAC } from '@/lib/platform'

export const DRAG_REGION_SELECTOR = '[class~="[-webkit-app-region:drag]"]'
export const NO_DRAG_REGION_SELECTOR = '[class~="[-webkit-app-region:no-drag]"], button'

/**
 * A press that lands in one of these is the control's, whatever lies under it.
 * Tauri's list, minus `[tabindex]`: the walk here runs to the root (the band a
 * press is on is usually not an ancestor of what it hit), and a focusable pane
 * container would switch off every band inside it.
 */
const INTERACTIVE_SELECTOR = [
  'a',
  'button',
  'input',
  'label',
  'select',
  'summary',
  'textarea',
  '[contenteditable]:not([contenteditable="false"])',
  '[role="button"]',
  '[role="checkbox"]',
  '[role="combobox"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="radio"]',
  '[role="slider"]',
  '[role="switch"]',
  '[role="tab"]',
  // Floating layers: a menu or a dialog that happens to overlap the band.
  '[role="dialog"]',
  '[role="listbox"]',
  '[role="menu"]',
  '[data-radix-popper-content-wrapper]',
  // Tauri's own attribute has Tauri's own handler; two would race.
  '[data-tauri-drag-region]'
].join(', ')

const holds = (rect: DOMRect, x: number, y: number): boolean =>
  rect.width > 0 && rect.height > 0 && x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom

/** Whether a press at (x, y) on `target` is on the window's drag region. */
export function isWindowDragPoint(target: EventTarget | null, x: number, y: number): boolean {
  if (!(target instanceof Element) || target.closest(INTERACTIVE_SELECTOR)) {
    return false
  }

  const doc = target.ownerDocument

  // The cheap question first: nearly every press is nowhere near a drag band,
  // and there are a few dozen of those against thousands of buttons.
  if (![...doc.querySelectorAll(DRAG_REGION_SELECTOR)].some(el => holds(el.getBoundingClientRect(), x, y))) {
    return false
  }

  let drag = false

  // Document order, as Chromium folds them: a later region overrides an earlier.
  for (const el of doc.querySelectorAll(`${DRAG_REGION_SELECTOR}, ${NO_DRAG_REGION_SELECTOR}`)) {
    if (holds(el.getBoundingClientRect(), x, y)) {
      drag = el.matches(DRAG_REGION_SELECTOR)
    }
  }

  return drag
}

type Press = Pick<
  MouseEvent,
  'altKey' | 'button' | 'clientX' | 'clientY' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'target'
>

/** Primary button, no modifier, on the region — the press the OS would have taken. */
const isDragPress = (event: Press): boolean =>
  event.button === 0 &&
  !event.altKey &&
  !event.ctrlKey &&
  !event.metaKey &&
  !event.shiftKey &&
  isWindowDragPoint(event.target, event.clientX, event.clientY)

/**
 * Arm the lever for this window. Desktop platforms only — the caller decides.
 * Returns the disarm.
 *
 * Two capture-phase listeners, because the page must not see a press Electron
 * would never have delivered: `pointerdown` comes first and is only swallowed
 * (Radix dismisses its layers on it — dragging the window by its titlebar under
 * a modal must not close the modal), then `mousedown` acts, exactly as Tauri's
 * own drag-region script does (`tauri/src/window/scripts/drag.js`): a press
 * starts the move and a second press (`detail === 2`) toggles maximise — except
 * on macOS, where the system zooms on the second RELEASE, and only if the
 * pointer has not moved since the press.
 */
export function installWindowDrag(): () => void {
  let mouse = true
  let zoomAt: null | { x: number; y: number } = null

  // Both are refused by Rust outside the capability's windows; a refusal is a
  // window that does not move, never an unhandled rejection.
  const move = (): void =>
    void getCurrentWindow()
      .startDragging()
      .catch(() => {})

  const zoom = (): void =>
    void getCurrentWindow()
      .toggleMaximize()
      .catch(() => {})

  const onPointerDown = (event: PointerEvent): void => {
    // A touch or pen press moves nothing; its compatibility `mousedown` arrives
    // after the finger has lifted.
    mouse = !event.pointerType || event.pointerType === 'mouse'

    if (mouse && isDragPress(event)) {
      event.stopPropagation()
    }
  }

  const onMouseDown = (event: MouseEvent): void => {
    zoomAt = null

    if (!mouse || !isDragPress(event)) {
      return
    }

    if (IS_MAC && event.detail === 2) {
      zoomAt = { x: event.clientX, y: event.clientY }

      return
    }

    // No text selection, no focus change, and nothing beneath sees it.
    event.preventDefault()
    event.stopPropagation()

    if (event.detail === 2) {
      zoom()
    } else {
      move()
    }
  }

  const onMouseUp = (event: MouseEvent): void => {
    const at = zoomAt

    zoomAt = null

    if (at && event.button === 0 && event.clientX === at.x && event.clientY === at.y) {
      zoom()
    }
  }

  window.addEventListener('pointerdown', onPointerDown, true)
  window.addEventListener('mousedown', onMouseDown, true)
  window.addEventListener('mouseup', onMouseUp, true)

  return () => {
    window.removeEventListener('pointerdown', onPointerDown, true)
    window.removeEventListener('mousedown', onMouseDown, true)
    window.removeEventListener('mouseup', onMouseUp, true)
  }
}
