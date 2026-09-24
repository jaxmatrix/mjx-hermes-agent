import { useEffect } from 'react'

import { setGuestVisible } from '@/lib/browser/host'
import { atom } from '@/store/atom'

/**
 * The price of a native guest: it is drawn by the COMPOSITOR, above the whole
 * DOM. Every app surface that must appear over the pane has to hide it first,
 * or a dialog opens behind a web page.
 *
 * One arbiter, one counter — deliberately not a per-portal rect intersection.
 * A rect test is right and is three times the code, and every occluding surface
 * in this app is modal-ish and short-lived.
 *
 * ponytail: count, not intersect. Upgrade to a rect test if a long-lived
 * NON-modal surface (a docked inspector) ever overlaps the pane.
 */

/** Immediate on hide; a dialog must never open behind the guest, not even for
 *  one frame. */
const SHOW_DEBOUNCE_MS = 16

const reasons = new Map<string, number>()

export const $guestOccluded = atom(false)

let showTimer: null | ReturnType<typeof setTimeout> = null
let applied = true

function total(): number {
  let sum = 0

  reasons.forEach(count => {
    sum += count
  })

  return sum
}

function apply(): void {
  const occluded = total() > 0

  $guestOccluded.set(occluded)

  if (showTimer !== null) {
    clearTimeout(showTimer)
    showTimer = null
  }

  if (occluded) {
    if (!applied) {
      return
    }

    applied = false
    void setGuestVisible(false).catch(() => undefined)

    return
  }

  // Debounced the other way: a menu chain — close one, open the next — would
  // otherwise flash the page twice.
  showTimer = setTimeout(() => {
    showTimer = null

    if (total() > 0 || applied) {
      return
    }

    applied = true
    void setGuestVisible(true).catch(() => undefined)
  }, SHOW_DEBOUNCE_MS)
}

/**
 * Claim the space above the guest. Returns the release, which is idempotent —
 * a component that unmounts twice under StrictMode must not double-decrement
 * and leave the guest hidden forever.
 */
export function claimGuestOcclusion(reason: string): () => void {
  reasons.set(reason, (reasons.get(reason) ?? 0) + 1)
  apply()

  let released = false

  return () => {
    if (released) {
      return
    }

    released = true

    const next = (reasons.get(reason) ?? 1) - 1

    if (next <= 0) {
      reasons.delete(reason)
    } else {
      reasons.set(reason, next)
    }

    apply()
  }
}

/** A component that must appear over the pane claims the space while mounted. */
export function useGuestOcclusion(reason: string): void {
  useEffect(() => claimGuestOcclusion(reason), [reason])
}

/**
 * What floats over a pane, read off the DOM.
 *
 * Universal's own primitives used to claim the space one by one
 * (`useGuestOcclusion` in dialog / popover / dropdown / select / context-menu /
 * the route overlay). `components/ui/` and `app/overlays/` are desktop's files
 * now, verbatim — desktop draws its page in a `<webview>`, which sits IN the
 * DOM's z-order and needs none of this — so the claim cannot live in them. It is
 * made for them instead, from what they render:
 *
 *   - a Radix dialog or alert (the command palette is one);
 *   - a Radix popper (popover, dropdown, select, desktop's context menu) —
 *     except a tooltip, which is small, transient and fires on every hover of
 *     the pane's own bar: hiding the page for it would be a flicker per button.
 *     The popper wrapper rather than `role="menu"` / `"listbox"`: the composer's
 *     completion drawer wears those roles too, and sits beside the pane;
 *   - a route overlay (`data-overlay-surface`: Settings and its siblings).
 */
const OCCLUDER_SELECTOR = '[role="dialog"], [role="alertdialog"], [data-overlay-surface]'

const POPPER_SELECTOR = '[data-radix-popper-content-wrapper]'

function occluderPresent(): boolean {
  if (document.querySelector(OCCLUDER_SELECTOR)) {
    return true
  }

  return [...document.querySelectorAll(POPPER_SELECTOR)].some(wrapper => !wrapper.querySelector('[role="tooltip"]'))
}

/**
 * Hide the guest while any of those is on screen. Armed by
 * the pane for as long as it is mounted; returns the disarm.
 *
 * A MutationObserver rather than a poll because its callback is a microtask: it
 * runs after the commit that mounted the surface and BEFORE the frame that would
 * paint it, which is the "not even for one frame" this module promises.
 */
export function watchGuestOccluders(): () => void {
  if (typeof MutationObserver === 'undefined') {
    return () => {}
  }

  let release: (() => void) | null = null

  const sync = (): void => {
    const present = occluderPresent()

    if (present && !release) {
      release = claimGuestOcclusion('dom-occluder')
    } else if (!present && release) {
      release()
      release = null
    }
  }

  const observer = new MutationObserver(sync)

  observer.observe(document.body, { childList: true, subtree: true })
  sync()

  return () => {
    observer.disconnect()
    release?.()
    release = null
  }
}

/** Test seam. */
export function __resetGuestOcclusion(): void {
  reasons.clear()
  applied = true

  if (showTimer !== null) {
    clearTimeout(showTimer)
    showTimer = null
  }

  $guestOccluded.set(false)
}
