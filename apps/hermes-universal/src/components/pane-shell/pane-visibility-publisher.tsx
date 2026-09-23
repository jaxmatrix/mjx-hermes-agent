import { useEffect } from 'react'

import { forgetPaneVisibility, setPaneVisible } from '@/store/pane-visibility-store'

/**
 * Mirror one tile layer's visibility into `store/pane-visibility-store`.
 *
 * A component rather than an effect inside the renderer so the write happens
 * after commit — the atom describes what is PAINTED, and a subscriber woken
 * during render would be reading an intention. Renders nothing.
 *
 * Unmount publishes `false` rather than dropping the entry: a caller holding the
 * atom has to SEE a pane go away, not be left subscribed to a value that stopped
 * moving.
 */
export function PaneVisibilityPublisher({ paneId, visible }: { paneId: string; visible: boolean }) {
  useEffect(() => {
    setPaneVisible(paneId, visible)
  }, [paneId, visible])

  useEffect(() => () => forgetPaneVisibility(paneId), [paneId])

  return null
}
