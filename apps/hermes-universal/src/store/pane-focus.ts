/**
 * The agent driving the SHELL — `pane.reveal` and `layout.apply` (MJXHRM-472).
 *
 * Ported from desktop `store/pane-focus.ts`, whose two exports are the whole
 * renderer half of the `focus_pane` and `apply_layout` tools.
 *
 * Unlike the read/drive bridges next door in `store/agent-read-requests.ts`,
 * these two frames are FIRE-AND-FORGET: the backend emits them through
 * `tools/desktop_ui.py::emit`, which returns as soon as a GUI client is wired,
 * and there is no `pane.reveal.respond` / `layout.apply.respond` method to
 * answer on (`tui_gateway/methods_prompt.py`). So a failure here cannot be
 * reported to the agent — the return value exists for tests and for a future
 * responder, and the honest answer to an unknown id is to do nothing rather
 * than guess a pane.
 *
 * Both are gated by the CALLER (store/event-router.ts) on the event's session
 * being the active one — desktop's `isActiveEvent`, i.e. "offer, don't hijack":
 * a background turn never moves the user's focus or rearranges their window.
 */

import { isLayoutNode, type LayoutNode } from '@/components/pane-shell/tree/model'
import { applyLayoutPreset, LAYOUTS_AREA } from '@/components/pane-shell/tree/presets'
import { revealTreePane } from '@/components/pane-shell/tree/store'
import { registry } from '@/contrib/registry'
import { WORKSPACE_PANE_ID } from '@/lib/pane-ids'
import { revealReview } from '@/store/review'
import { ownsPersistedAppState } from '@/store/windows'

/**
 * `focus_pane`'s pane vocabulary → universal's.
 *
 * The tool's enum is CLOSED (`tools/focus_pane_tool.py`: chat, files, terminal,
 * review, sessions), and every one of the five has a real universal pane, so
 * nothing is dropped. The names differ in one place: the tool's "chat" is the
 * tree's `workspace` tile.
 *
 * Each entry drives the pane's OWN reveal path, so a revealed pane matches a
 * user-driven open. Four go through `revealTreePane` — which un-dismisses the
 * pane, opens its collapsed SIDE through that side's bound store (so the
 * titlebar toggle stays truthful), and fronts it in its tab group. `review` is
 * the exception: it must also LOAD its diff, and on a narrow viewport it is an
 * overlay rather than a tree pane, both of which `revealReview` already owns.
 *
 * Desktop's map differs only because its shell differs: there the sidebar and
 * the file browser are their own stores (`setSidebarOpen` / `setFileBrowserOpen`)
 * rather than tiles in a layout tree.
 */
const PANE_REVEALERS: Record<string, () => void> = {
  chat: () => revealTreePane(WORKSPACE_PANE_ID),
  files: () => revealTreePane('files'),
  review: () => revealReview(),
  sessions: () => revealTreePane('sessions'),
  terminal: () => revealTreePane('terminal')
}

/**
 * Reveal a pane by the `focus_pane` tool's name. False = unknown pane, or a
 * window that does not own the app's layout.
 *
 * The window guard is universal-only and has no desktop counterpart: desktop is
 * one window, while universal runs the same bundle in detached tiles, satellite
 * overlays (HUD, wake indicator) and the Android activity screens, all sharing
 * one origin's `localStorage`. `ownsPersistedAppState()` is the existing
 * predicate for "this window may write the app's state" (store/windows.ts) —
 * without it a summoned HUD would reveal panes into the real window's tree.
 */
export function revealBridgePane(pane: string): boolean {
  const reveal = PANE_REVEALERS[pane]

  if (!reveal || !ownsPersistedAppState()) {
    return false
  }

  reveal()

  return true
}

/**
 * Apply a layout preset by id, resolved against the layouts contribution
 * registry — the SAME list the layout picker and the titlebar menu render, so
 * the core presets (default / focus / terminal-deck / quad), plugin presets and
 * user-saved presets are all addressable by the `apply_layout` tool. False for
 * an unknown id, an id whose contribution is not a layout tree, or a window
 * that does not own the app's layout.
 */
export function applyBridgeLayoutPreset(preset: string): boolean {
  if (!preset || !ownsPersistedAppState()) {
    return false
  }

  const entry = registry
    .getArea(LAYOUTS_AREA)
    .find(candidate => candidate.id === preset && isLayoutNode(candidate.data))

  if (!entry) {
    return false
  }

  applyLayoutPreset(entry.id, entry.data as LayoutNode)

  return true
}
