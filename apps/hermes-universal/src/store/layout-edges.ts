/**
 * Window-edge pane visibility derived from flip + sidebar/files.
 * Chat header and titlebar need these; desktop layout no longer exports them.
 */
import { computed } from '@/store/atom'
import { $fileBrowserOpen, $panesFlipped, $sidebarOpen } from '@/store/layout'

/** True when any chrome pane occupies the window's left edge. */
export const $leftEdgeOpen = computed([$panesFlipped, $sidebarOpen, $fileBrowserOpen], (flipped, sidebar, files) =>
  flipped ? files : sidebar
)

/** True when any chrome pane occupies the window's right edge. */
export const $rightEdgeOpen = computed([$panesFlipped, $sidebarOpen, $fileBrowserOpen], (flipped, sidebar, files) =>
  flipped ? sidebar : files
)
