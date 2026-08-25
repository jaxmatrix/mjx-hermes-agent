import { TERMINAL_HOST_ATTR } from '@/app/context-menu/markers'

// The terminal's handle for the app-wide context menu.
//
// xterm draws to a canvas: there is no DOM selection to read and no field to
// paste into, so the menu cannot act on a terminal without asking the live
// instance. A `WeakMap` keyed by the host element means a destroyed terminal's
// handle is collected with its node — nothing to reap, nothing to leak.
//
// This is a DIFFERENT registry from `terminal/buffer.ts` (MJXHRM-472), which
// keys agent-visible readers by terminal id. Same subsystem, different key
// space, and this one has exactly one consumer.

export interface TerminalMenuHandle {
  getSelection: () => string
  /** `null` on the READ-ONLY agent mirror — that tab has no PTY to paste into. */
  paste: ((text: string) => void) | null
  selectAll: () => void
}

const handles = new WeakMap<Element, TerminalMenuHandle>()

/** Register (or replace) the handle for one xterm host. Idempotent unregister. */
export function registerTerminalContextMenu(host: Element, handle: TerminalMenuHandle): () => void {
  handles.set(host, handle)

  return () => {
    if (handles.get(host) === handle) {
      handles.delete(host)
    }
  }
}

/** The handle for the terminal this element sits in, or null. */
export function terminalMenuHandleFor(element: Element | null): TerminalMenuHandle | null {
  const host = element?.closest(`[${TERMINAL_HOST_ATTR}]`) ?? null

  return host ? (handles.get(host) ?? null) : null
}
