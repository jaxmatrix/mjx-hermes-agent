/**
 * `agent.terminal.output` / `terminal.close` (MJXHRM-472).
 *
 * Neither frame is answered, so the whole contract is what happens to the tabs
 * and the buffer. The cases that matter are the ones a happy-path test would
 * miss: output arriving before any tab exists, a close that has to STICK
 * against a process that keeps writing, and a close for a process that was
 * never surfaced.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const stream = vi.hoisted(() => ({ route: null as ((event: { payload?: unknown; type: string }) => void) | null }))

vi.mock('@/store/gateway', () => ({
  addGatewayEventListener: (listener: (event: { payload?: unknown; type: string }) => void) => {
    stream.route = listener

    return () => {
      stream.route = null
    }
  }
}))

import './agent-terminal-bridge'

import {
  forgetAgentTerminal,
  hasAgentTerminalOutput,
  registerAgentTerminalWriter
} from '@/app/right-pane/terminal/agent-terminal-stream'
import { $activeTerminalId, $terminals, __resetAgentTerminals, closeTerminal } from '@/store/terminals'

const send = (type: string, payload: Record<string, unknown>) => stream.route?.({ payload, type })

const tabs = () => $terminals.get().map(term => term.procId ?? term.id)

beforeEach(() => {
  $terminals.set([])
  $activeTerminalId.set(null)
  __resetAgentTerminals()
  forgetAgentTerminal('proc-1')
  forgetAgentTerminal('proc-2')
})

describe('agent.terminal.output', () => {
  it('surfaces a read-only tab for a process that had none', () => {
    send('agent.terminal.output', { chunk: 'build started\r\n', process_id: 'proc-1' })

    expect(tabs()).toEqual(['proc-1'])
    expect($terminals.get()[0].procId).toBe('proc-1')
  })

  // "Offer, don't hijack": a background build is not a request for the screen.
  it('does not front the new tab or steal the active selection', () => {
    $terminals.set([{ id: 'term-1', title: 'Terminal 1' }])
    $activeTerminalId.set('term-1')

    send('agent.terminal.output', { chunk: 'x', process_id: 'proc-1' })

    expect($activeTerminalId.get()).toBe('term-1')
  })

  it('reuses the tab on later chunks instead of opening one per chunk', () => {
    send('agent.terminal.output', { chunk: 'a', process_id: 'proc-1' })
    send('agent.terminal.output', { chunk: 'b', process_id: 'proc-1' })
    send('agent.terminal.output', { chunk: 'c', process_id: 'proc-2' })

    expect(tabs()).toEqual(['proc-1', 'proc-2'])
  })

  // The reason the buffer is written before the tab is created: a view mounted
  // by that creation registers its writer and must find the chunk waiting.
  it('buffers output so a writer registered afterwards replays it', () => {
    send('agent.terminal.output', { chunk: 'line one\r\n', process_id: 'proc-1' })
    send('agent.terminal.output', { chunk: 'line two\r\n', process_id: 'proc-1' })

    const write = vi.fn()

    registerAgentTerminalWriter('proc-1', write)

    expect(write).toHaveBeenCalledWith('line one\r\nline two\r\n')

    // And a chunk arriving after registration goes straight through.
    send('agent.terminal.output', { chunk: 'line three\r\n', process_id: 'proc-1' })
    expect(write).toHaveBeenLastCalledWith('line three\r\n')
  })

  it('ignores a frame with no process id or no chunk', () => {
    send('agent.terminal.output', { chunk: 'orphan' })
    send('agent.terminal.output', { process_id: 'proc-1' })

    expect(tabs()).toEqual([])
    expect(hasAgentTerminalOutput('proc-1')).toBe(false)
  })
})

describe('terminal.close', () => {
  it('closes the tab mirroring that process, leaving user shells alone', () => {
    $terminals.set([{ id: 'term-1', title: 'Terminal 1' }])
    send('agent.terminal.output', { chunk: 'x', process_id: 'proc-1' })
    send('agent.terminal.output', { chunk: 'y', process_id: 'proc-2' })

    send('terminal.close', { process_id: 'proc-1' })

    expect(tabs()).toEqual(['term-1', 'proc-2'])
  })

  // The failure a happy-path test misses entirely: `close_terminal` on a
  // still-running build would undo itself on the build's very next chunk.
  it('stays closed when the process keeps writing', () => {
    send('agent.terminal.output', { chunk: 'x', process_id: 'proc-1' })
    send('terminal.close', { process_id: 'proc-1' })
    send('agent.terminal.output', { chunk: 'still going', process_id: 'proc-1' })

    expect(tabs()).toEqual([])
    // The output is NOT lost — the tool's contract is that it keeps buffering.
    expect(hasAgentTerminalOutput('proc-1')).toBe(true)
  })

  // Same rule for the user's own close: the rail's close verbs must not be
  // undone by the next chunk either.
  it('honours a tab the USER closed from the rail', () => {
    send('agent.terminal.output', { chunk: 'x', process_id: 'proc-1' })
    closeTerminal($terminals.get()[0].id)
    send('agent.terminal.output', { chunk: 'more', process_id: 'proc-1' })

    expect(tabs()).toEqual([])
  })

  it('suppresses a process closed before it ever produced output', () => {
    send('terminal.close', { process_id: 'proc-1' })
    send('agent.terminal.output', { chunk: 'late start', process_id: 'proc-1' })

    expect(tabs()).toEqual([])
  })
})
