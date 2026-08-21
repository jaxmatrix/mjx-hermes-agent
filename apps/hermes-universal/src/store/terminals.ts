import { persistentAtom } from '@/lib/persisted'
import { atom } from '@/store/atom'
import { setTerminalOpen } from '@/store/layout'
import type { TerminalHostPreference } from '@/transport/terminal-transport'

// Multi-terminal state for the right pane (adapted, much simplified, from
// desktop's right-sidebar/terminal/terminals.ts). Each entry is just an id — the
// live shell + xterm live in the per-id TerminalView. Not persisted (shells don't
// survive an app restart). Closing the last one hides the terminal area.

/**
 * Which machine new terminals shell into: `auto` applies the gateway-mode rule
 * (see transport/terminal-transport.ts), `device`/`gateway` pin it. Persisted
 * because it's a standing preference, and read only at spawn — flipping it never
 * moves a running shell.
 */
export const $terminalHostPreference = persistentAtom<TerminalHostPreference>('hermes.terminalHost', 'auto', {
  decode: raw => (raw === 'device' || raw === 'gateway' ? raw : 'auto'),
  encode: value => value
})

export function setTerminalHostPreference(preference: TerminalHostPreference): void {
  $terminalHostPreference.set(preference)
}

export interface TerminalEntry {
  id: string
  /**
   * The background process this tab MIRRORS, when it is one (MJXHRM-472).
   *
   * Present ⇒ the tab is READ-ONLY: no PTY is spawned for it and its contents
   * come from `agent.terminal.output` chunks (app/right-pane/terminal/
   * agent-terminal-stream.ts). Absent ⇒ an ordinary user shell.
   */
  procId?: string
  title: string
  /** The directory this shell was SPAWNED in, recorded by the view once the
   *  transport settles. A terminal keeps the directory it was opened in, so this
   *  is a spawn-time fact, not a live `pwd` — the shell may have `cd`-ed since
   *  and we have no way to know. It exists so switching chats can re-select the
   *  terminal that already belongs to that chat's project. */
  cwd?: string
}

let counter = 0

/** Processes whose read-only tab has been closed; see `ensureAgentTerminal`. */
const dismissedProcs = new Set<string>()

/** Test seam — forgets which agent tabs were dismissed. */
export function __resetAgentTerminals(): void {
  dismissedProcs.clear()
}

export const $terminals = atom<TerminalEntry[]>([])
export const $activeTerminalId = atom<string | null>(null)

export function createTerminal(): string {
  counter += 1
  const id = `term-${counter}`
  $terminals.set([...$terminals.get(), { id, title: `Terminal ${counter}` }])
  $activeTerminalId.set(id)

  return id
}

/**
 * The read-only tab mirroring a background process, created on demand.
 *
 * Called when the FIRST `agent.terminal.output` chunk for a process arrives.
 * Deliberately does NOT front the tab or open the terminal area: the agent
 * running something in the background is not a request for the user's screen
 * (desktop AGENTS.md: offer, don't hijack). The tab appears in the rail with
 * its buffered output waiting, and `close_terminal` can drop it again.
 *
 * Desktop opens these from its status stack instead; universal has no
 * background-process feed yet (store/composer-status.ts), so first output is
 * the opener. Idempotent — returns the existing tab's id when there is one.
 */
export function ensureAgentTerminal(procId: string, title?: string): string {
  const existing = $terminals.get().find(term => term.procId === procId)

  if (existing) {
    return existing.id
  }

  // Once the agent (or the user) has closed this process's tab, later output
  // must not drag it back — a long-running build would otherwise reopen the tab
  // it was just told to drop, on its very next chunk. Desktop calls the same
  // idea `surfacedProcs`. Session-scoped and bounded by the number of processes
  // whose tabs were closed.
  if (dismissedProcs.has(procId)) {
    return ''
  }

  const id = `agent-${procId}`

  $terminals.set([...$terminals.get(), { id, procId, title: title || procId }])

  return id
}

/**
 * Close the read-only tab mirroring a background process — the agent's
 * `close_terminal` tool → `terminal.close`. The process is NOT killed and its
 * output keeps buffering; only the view is dropped. False when no such tab is
 * open, which is the honest answer to closing a tab that was never surfaced.
 */
export function closeAgentTerminalByProc(procId: string): boolean {
  // Dismissed even when no tab is open: `close_terminal` on a process that was
  // never surfaced still means "do not show this one".
  dismissedProcs.add(procId)

  const term = $terminals.get().find(entry => entry.procId === procId)

  if (!term) {
    return false
  }

  closeTerminal(term.id)

  return true
}

/** Ensure at least one terminal exists + is active (called when the area opens). */
export function ensureTerminal(): void {
  // A read-only agent tab is not a shell the user can type in, so opening the
  // area with only those present must still spawn one.
  if (!$terminals.get().some(term => term.procId === undefined)) {
    createTerminal()
  } else if (!$activeTerminalId.get()) {
    $activeTerminalId.set($terminals.get()[0].id)
  }
}

/** Record the directory a terminal actually spawned in (called by the view once
 *  its transport is up). Idempotent. */
export function noteTerminalCwd(id: string, cwd: string): void {
  const terminals = $terminals.get()
  const current = terminals.find(term => term.id === id)

  if (!current || current.cwd === cwd) {
    return
  }

  $terminals.set(terminals.map(term => (term.id === id ? { ...term, cwd } : term)))
}

/**
 * Front the terminal belonging to `cwd`, if one exists.
 *
 * Called when the focused chat changes, so moving between two projects moves
 * between their shells instead of leaving you typing into the other project's
 * directory. Deliberately conservative in two ways: it never SPAWNS a terminal
 * (switching chats must not start shells the user did not ask for), and it does
 * nothing when no terminal matches — an unrelated chat leaves whatever you were
 * looking at exactly where it was, rather than yanking you to terminal 1.
 */
export function selectTerminalForCwd(cwd: string): void {
  const target = cwd.trim()

  if (!target) {
    return
  }

  const match = $terminals.get().find(term => term.cwd === target)

  if (match && match.id !== $activeTerminalId.get()) {
    $activeTerminalId.set(match.id)
  }
}

export function selectTerminal(id: string): void {
  if ($terminals.get().some(term => term.id === id)) {
    $activeTerminalId.set(id)
  }
}

function afterRemoval(next: TerminalEntry[], removedActive: boolean): void {
  // Whoever closed an agent tab — the rail's five close verbs, or the agent's
  // own `close_terminal` — meant it. Recording the dismissal HERE rather than in
  // `closeAgentTerminalByProc` is what stops the next output chunk from dragging
  // a user-closed tab straight back (`ensureAgentTerminal`); a guard in one of
  // six callers would have left the other five broken.
  const kept = new Set(next.map(term => term.procId))

  for (const term of $terminals.get()) {
    if (term.procId !== undefined && !kept.has(term.procId)) {
      dismissedProcs.add(term.procId)
    }
  }

  $terminals.set(next)

  if (removedActive) {
    $activeTerminalId.set(next.length ? next[next.length - 1].id : null)
  }

  if (next.length === 0) {
    setTerminalOpen(false)
  }
}

export function closeTerminal(id: string): void {
  afterRemoval(
    $terminals.get().filter(term => term.id !== id),
    $activeTerminalId.get() === id
  )
}

/** Close every terminal but this one. Through `afterRemoval` like the other
 *  three verbs: it was the one that rewrote the list itself, so with an id no
 *  longer in the list it emptied the rail and left the terminal AREA open on
 *  nothing — `⌃\`` then read as "hide" while showing a blank pane. */
export function closeOtherTerminals(id: string): void {
  const keep = $terminals.get().filter(term => term.id === id)

  afterRemoval(keep, !keep.some(term => term.id === $activeTerminalId.get()))
}

/** The fourth verb of the shared tab close group. The rail's list is ORDERED
 *  (the numbered `1. …` labels are that order), so "to the right" means the
 *  same thing here as on a tab strip; the rail simply never offered it. */
export function closeTerminalsToRight(id: string): void {
  const terminals = $terminals.get()
  const at = terminals.findIndex(term => term.id === id)

  if (at < 0) {
    return
  }

  const keep = terminals.slice(0, at + 1)

  if (keep.length === terminals.length) {
    return
  }

  afterRemoval(keep, !keep.some(term => term.id === $activeTerminalId.get()))
}

/** How many terminals each close verb would hit — the rail's `PaneTabCloseCounts`. */
export function terminalCloseTargets(id: string): { all: number; others: number; right: number } {
  const terminals = $terminals.get()
  const at = terminals.findIndex(term => term.id === id)

  return {
    all: terminals.length,
    others: at < 0 ? 0 : terminals.length - 1,
    right: at < 0 ? 0 : terminals.length - 1 - at
  }
}

// ── Keybind entry points (view.nextTerminal / prevTerminal / closeTerminal) ──
// Desktop keeps these in right-sidebar/terminal/terminals.ts; here they sit with
// the rest of the terminal state. Both are no-ops with nothing open, so the
// hotkeys stay harmless when the terminal area is empty.

/** Step the active terminal by `direction`, wrapping at both ends. */
export function cycleTerminal(direction: 1 | -1): void {
  const terminals = $terminals.get()

  if (terminals.length < 2) {
    return
  }

  const current = terminals.findIndex(term => term.id === $activeTerminalId.get())
  const start = current === -1 ? 0 : current
  const next = (start + direction + terminals.length) % terminals.length

  $activeTerminalId.set(terminals[next].id)
}

export function closeActiveTerminal(): void {
  const id = $activeTerminalId.get()

  if (id) {
    closeTerminal(id)
  }
}

export function closeAllTerminals(): void {
  for (const term of $terminals.get()) {
    if (term.procId !== undefined) {
      dismissedProcs.add(term.procId)
    }
  }

  $terminals.set([])
  $activeTerminalId.set(null)
  setTerminalOpen(false)
}
