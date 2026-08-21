/**
 * Live output from the agent's BACKGROUND processes — `agent.terminal.output`.
 *
 * Every `terminal(background=true)` run streams its stdout to the client as
 * chunks keyed by process id (`tui_gateway/server.py::_wire_agent_terminal_output`,
 * wired unconditionally — not gated on the `desktop_ui` toolset), and universal
 * dropped every one of them. Chunks route straight to the matching read-only
 * xterm: no polling, no tail truncation.
 *
 * A capped per-process backlog is what lets a tab opened mid-stream replay what
 * it missed, and a closed-then-reopened tab restore its history. Ported from
 * desktop `app/right-sidebar/terminal/agent-terminal-stream.ts`, minus the two
 * functions that exist there to reconcile against the status stack's
 * `process.list` polling — universal has no background-process feed yet
 * (store/composer-status.ts), and a snapshot reconciler with nothing to
 * reconcile against is a guess about an API that has not landed.
 */

type Writer = (chunk: string) => void

const writers = new Map<string, Writer>()
const backlog = new Map<string, string>()

/** Roughly a screenful of scrollback per process. The cap is what keeps a
 *  chatty background build from growing this map without bound — the process
 *  registry, not the client, is the durable record of its output. */
const MAX_BACKLOG = 256_000

/** A live agent terminal registers its xterm write and replays the backlog.
 *  Returns an idempotent unregister. */
export function registerAgentTerminalWriter(procId: string, write: Writer): () => void {
  writers.set(procId, write)

  const history = backlog.get(procId)

  if (history) {
    write(history)
  }

  return () => {
    if (writers.get(procId) === write) {
      writers.delete(procId)
    }
  }
}

/** Append a streamed chunk: buffer it (capped) for a future open, and write it
 *  to the live terminal if one is mounted. */
export function writeAgentTerminalChunk(procId: string, chunk: string): void {
  if (!procId || !chunk) {
    return
  }

  const next = (backlog.get(procId) ?? '') + chunk

  backlog.set(procId, next.length > MAX_BACKLOG ? next.slice(-MAX_BACKLOG) : next)
  writers.get(procId)?.(chunk)
}

/** Whether anything has ever been buffered for this process — i.e. whether a
 *  tab reopened for it would have something to show. */
export function hasAgentTerminalOutput(procId: string): boolean {
  return backlog.has(procId)
}

/** Drop a finished process's buffer. Closing the TAB deliberately does not call
 *  this (the `close_terminal` tool's whole contract is "the output keeps
 *  buffering and the user can reopen it"); this exists for teardown and tests. */
export function forgetAgentTerminal(procId: string): void {
  backlog.delete(procId)
  writers.delete(procId)
}
