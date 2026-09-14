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

/** The hook every portalled primitive in `components/ui/` mounts. */
export function useGuestOcclusion(reason: string): void {
  useEffect(() => claimGuestOcclusion(reason), [reason])
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
