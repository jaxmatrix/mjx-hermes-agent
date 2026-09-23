import { atom, type ReadableAtom } from '@/store/atom'

/**
 * Pane visibility as an ATOM, beside the React context that already answers the
 * same question.
 *
 * The context (`components/pane-shell/pane-visibility.ts`) is the right shape
 * for a React consumer and the wrong one for everybody else: a plugin's polling
 * loop, a subscription it wants to pause, a `host.paneVisibility(id)` a
 * non-component holds. And rule 28 rules out the obvious alternative — the
 * registry's `when()` is evaluated only when an area's snapshot is rebuilt, so a
 * predicate over visibility would simply never re-run.
 *
 * ONE writer: the tile renderer that already computes the value and stamps
 * `PANE_HIDDEN_ATTR` from it. Nothing derives visibility a second way, which is
 * the whole reason this is a published value rather than a DOM read.
 *
 * A pane nobody has published is FALSE, not undefined: an id that does not exist
 * is not visible, and a caller should not have to tell those two apart.
 */

const panes = new Map<string, ReturnType<typeof atom<boolean>>>()

function slot(paneId: string) {
  let existing = panes.get(paneId)

  if (!existing) {
    existing = atom(false)
    panes.set(paneId, existing)
  }

  return existing
}

/** Readonly visibility of one pane. Stable per id, so a subscriber taken once
 *  keeps working across mounts. */
export function $paneVisible(paneId: string): ReadableAtom<boolean> {
  return slot(paneId)
}

/** Publish a pane's visibility. Called by the tile renderer only. */
export function setPaneVisible(paneId: string, visible: boolean): void {
  const target = slot(paneId)

  if (target.get() !== visible) {
    target.set(visible)
  }
}

/** A pane went away entirely (unmounted, detached, closed). Reported as hidden
 *  rather than dropped: a plugin holding the atom must see it turn false, not
 *  keep a handle on a value that stopped moving. */
export function forgetPaneVisibility(paneId: string): void {
  panes.get(paneId)?.set(false)
}

/** Test seam. */
export function __resetPaneVisibility(): void {
  for (const pane of panes.values()) {
    pane.set(false)
  }

  panes.clear()
}
