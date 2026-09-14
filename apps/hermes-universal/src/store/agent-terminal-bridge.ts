/**
 * The agent's background terminals — `agent.terminal.output` and `terminal.close`.
 *
 * The other half of the desktop-surface bridge (`store/agent-read-requests.ts`
 * owns the blocking half, `store/pane-focus.ts` the shell half). Both frames
 * here are fire-and-forget: nothing is parked waiting on us, so the cost of
 * dropping them was silent — every `terminal(background=true)` run streamed its
 * output at a client that threw it away, and the `close_terminal` tool reported
 * success while the tab it named stayed open.
 *
 * Self-registers on the gateway stream rather than riding the event router, for
 * the same two reasons `agent-read-requests.ts` does — and one more. These
 * frames are keyed by PROCESS, not by conversation: the gateway resolves the
 * owning window by looking the process's session up in its live table
 * (`_owner_sid_for_process`) and emits with an EMPTY session id when it cannot
 * find one, which the router would either misattribute to the focused chat or
 * fail closed on.
 *
 * No window guard, deliberately. `$terminals` is per-WebView module state, not
 * persisted shared state, so a tab created here is created in the window whose
 * socket received the frame — the one running that process's session.
 */

import { writeAgentTerminalChunk } from '@/app/right-pane/terminal/agent-terminal-stream'
import type { GatewayEvent } from '@/gateway'
import { addGatewayEventListener } from '@/store/gateway'
import { closeAgentTerminalByProc, ensureAgentTerminal } from '@/store/terminals'

function routeAgentTerminalEvent(event: GatewayEvent): void {
  const payload = (event.payload ?? {}) as Record<string, unknown>
  const procId = typeof payload.process_id === 'string' ? payload.process_id : ''

  if (!procId) {
    return
  }

  switch (event.type) {
    case 'agent.terminal.output': {
      const chunk = typeof payload.chunk === 'string' ? payload.chunk : ''

      if (!chunk) {
        return
      }

      // Buffer FIRST, then surface: `ensureAgentTerminal` mounts a view that
      // replays the backlog on registration, so a tab created here must find
      // this chunk already in it rather than racing to receive it.
      writeAgentTerminalChunk(procId, chunk)
      ensureAgentTerminal(procId)

      break
    }

    case 'terminal.close': {
      // The agent dropping its own read-only tab via `close_terminal`. The
      // process is untouched and its output keeps buffering — this only drops
      // the view, which is exactly the tool's documented contract. Later output
      // does NOT drag the tab back (see `ensureAgentTerminal`), or closing the
      // tab of a running build would undo itself on its next chunk.
      closeAgentTerminalByProc(procId)

      break
    }

    default:
      break
  }
}

addGatewayEventListener(routeAgentTerminalEvent)
