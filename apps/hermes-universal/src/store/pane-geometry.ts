/**
 * Right-pane geometry ids/sizes + sidebar overlay mount flag.
 *
 * Desktop's layout store dropped these exports; universal chrome still needs
 * them. Protected so absorb cannot wipe the bridge.
 */
import { atom } from '@/store/atom'
import { ensurePaneRegistered } from '@/store/panes'

export const FILE_TREE_PANE_ID = 'file-tree'
export const PREVIEW_PANE_ID = 'preview'
export const TERMINAL_PANE_ID = 'terminal'

export const FILE_TREE_DEFAULT_WIDTH = 260
export const FILE_TREE_MIN_WIDTH = 180
export const FILE_TREE_MAX_WIDTH = 420
export const PREVIEW_DEFAULT_WIDTH = 440
export const PREVIEW_MIN_WIDTH = 300
export const PREVIEW_MAX_WIDTH = 760
export const TERMINAL_DEFAULT_HEIGHT = 260
export const TERMINAL_MIN_HEIGHT = 120
export const TERMINAL_MAX_HEIGHT = 640

/** Terminal as a full-height right column when file tree + editor are closed. */
export const TERMINAL_COLUMN_PANE_ID = 'terminal-column'
export const TERMINAL_COLUMN_DEFAULT_WIDTH = 480
export const TERMINAL_COLUMN_MIN_WIDTH = 300
export const TERMINAL_COLUMN_MAX_WIDTH = 900

ensurePaneRegistered(FILE_TREE_PANE_ID, { open: true })
ensurePaneRegistered(PREVIEW_PANE_ID, { open: true })
ensurePaneRegistered(TERMINAL_PANE_ID, { open: true })
ensurePaneRegistered(TERMINAL_COLUMN_PANE_ID, { open: true })

export const NEW_SESSION_FLASH_EVENT = 'hermes:new-session-flash'
export const SESSION_SEARCH_FOCUS_EVENT = 'hermes:focus-session-search'

/** True while the chat sidebar is mounted as a floating overlay (narrow). */
export const $sidebarOverlayMounted = atom(false)

export function setSidebarOverlayMounted(mounted: boolean): void {
  $sidebarOverlayMounted.set(mounted)
}
