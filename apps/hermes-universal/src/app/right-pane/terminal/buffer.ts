/**
 * The agent reading the in-app terminal — `read_terminal` / `terminal.read.request`.
 *
 * Ported from desktop `app/right-sidebar/terminal/buffer.ts`. Its whole reason
 * for existing is that the live xterm `Terminal` is a component-local ref
 * (`terminal-view.tsx`), so nothing outside that component can reach the buffer
 * the agent is being asked about. Each mounted view registers a reader keyed by
 * its terminal id; the read resolves whichever id is active.
 *
 * ONE difference from desktop, and it removes a bug rather than porting it:
 * desktop keeps its own `activeId` here, mirrored from the tab selection, so
 * "which terminal does the agent see" is a second copy of state that can
 * disagree with the rail. Universal already has `$activeTerminalId`
 * (store/terminals.ts) as THE selection, so this module reads it instead of
 * shadowing it — a deactivating tab's cleanup cannot race the tab that just
 * activated, because there is nothing to race.
 *
 * Multi-window: every WebView boots its own bundle and its own gateway socket,
 * and a detached tile window can host the terminal pane itself. The frame
 * arrives on the socket that owns the session, so "the terminal" resolves to
 * the active terminal of the window running that turn — not to a random one.
 */

import type { Terminal } from '@xterm/xterm'

import { $activeTerminalId } from '@/store/terminals'

/**
 * Serialized view of one terminal, handed to the agent's `read_terminal` tool.
 *
 * Snake_case because this is a WIRE shape, not an app type: it is
 * JSON-stringified onto `terminal.read.respond` and `read_terminal_tool.py`
 * passes the object straight through to the model, whose schema documents
 * exactly these keys. Line indices are absolute into xterm's buffer (0 = oldest
 * scrollback line) so the agent can page with start/count against total_lines.
 */
export interface TerminalReadResult {
  cursor_row: number
  end: number
  start: number
  text: string
  total_lines: number
  viewport_rows: number
}

export interface TerminalReadOptions {
  count?: number
  start?: number
}

type Reader = (options: TerminalReadOptions) => TerminalReadResult

const readers = new Map<string, Reader>()

/** Register a live terminal's reader; returns an idempotent unregister. */
export function registerTerminalReader(id: string, reader: Reader): () => void {
  readers.set(id, reader)

  return () => {
    if (readers.get(id) === reader) {
      readers.delete(id)
    }
  }
}

/** The active terminal's contents, or null when no terminal is mounted — which
 *  `read_terminal_tool.py` reports as "No in-app terminal is open". */
export function readActiveTerminal(options: TerminalReadOptions = {}): null | TerminalReadResult {
  const id = $activeTerminalId.get()
  const reader = id === null ? undefined : readers.get(id)

  return reader ? reader(options) : null
}

/** Build the reader for one xterm instance. */
export function makeTerminalReader(term: Terminal): Reader {
  return ({ count, start }) => {
    const buf = term.buffer.active
    const total = buf.length
    const rows = term.rows
    // Default window = the visible screen; baseY is the viewport's top row.
    const from = Math.max(0, Math.min(start ?? buf.baseY, total))
    const to = Math.max(from, Math.min(from + Math.max(1, count ?? rows), total))

    const lines: string[] = []

    // translateToString(true) right-trims and resolves wide chars, dropping SGR
    // colors — exactly what the agent wants.
    for (let i = from; i < to; i += 1) {
      lines.push(buf.getLine(i)?.translateToString(true) ?? '')
    }

    while (lines.length && !lines[lines.length - 1].trim()) {
      lines.pop()
    }

    return {
      cursor_row: buf.baseY + buf.cursorY,
      end: to,
      start: from,
      text: lines.join('\n'),
      total_lines: total,
      viewport_rows: rows
    }
  }
}
