import { atom } from '@/store/atom'
import { setTerminalOpen } from '@/store/layout'

// Multi-terminal state for the right pane (adapted, much simplified, from
// desktop's right-sidebar/terminal/terminals.ts). Each entry is just an id — the
// live shell + xterm live in the per-id TerminalView. Not persisted (shells don't
// survive an app restart). Closing the last one hides the terminal area.

export interface TerminalEntry {
  id: string
  title: string
}

let counter = 0

export const $terminals = atom<TerminalEntry[]>([])
export const $activeTerminalId = atom<string | null>(null)

export function createTerminal(): string {
  counter += 1
  const id = `term-${counter}`
  $terminals.set([...$terminals.get(), { id, title: `Terminal ${counter}` }])
  $activeTerminalId.set(id)
  return id
}

/** Ensure at least one terminal exists + is active (called when the area opens). */
export function ensureTerminal(): void {
  if ($terminals.get().length === 0) createTerminal()
  else if (!$activeTerminalId.get()) $activeTerminalId.set($terminals.get()[0].id)
}

export function selectTerminal(id: string): void {
  if ($terminals.get().some(term => term.id === id)) $activeTerminalId.set(id)
}

function afterRemoval(next: TerminalEntry[], removedActive: boolean): void {
  $terminals.set(next)
  if (removedActive) $activeTerminalId.set(next.length ? next[next.length - 1].id : null)
  if (next.length === 0) setTerminalOpen(false)
}

export function closeTerminal(id: string): void {
  afterRemoval(
    $terminals.get().filter(term => term.id !== id),
    $activeTerminalId.get() === id
  )
}

export function closeOtherTerminals(id: string): void {
  const keep = $terminals.get().filter(term => term.id === id)
  $terminals.set(keep)
  $activeTerminalId.set(keep.length ? id : null)
}

export function closeAllTerminals(): void {
  $terminals.set([])
  $activeTerminalId.set(null)
  setTerminalOpen(false)
}
