/**
 * These requests park a running agent tool until this client answers, so the
 * property that matters is not "we answer well" but "we ALWAYS answer" —
 * including with no reader registered, and when the reader throws.
 *
 * They arrive as server→client requests now (MJXHRM-520), so the test drives
 * `answerAgentBridgeRequest` with a request whose `respond` is a spy, rather
 * than pushing a `*.request` event and watching for a `*.respond` RPC. The
 * methods those RPCs named no longer exist on the backend.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ServerRequest, ServerRequestParams } from '@/gateway'

const terminal = vi.hoisted(() => ({ read: vi.fn<(options: unknown) => unknown>() }))

vi.mock('@/app/right-pane/terminal/buffer', () => ({ readActiveTerminal: terminal.read }))

import {
  __resetAgentReadRequests,
  answerAgentBridgeRequest,
  registerPreviewActor,
  registerPreviewReader,
  registerTourDriver,
  registerWindowBelowReader
} from './agent-read-requests'

/** A server request with spies for the two ways it can be settled. */
function makeRequest(method: string, params: ServerRequestParams = {}) {
  const respond = vi.fn()
  const fail = vi.fn()
  const request: ServerRequest = { fail, id: `srq-${method}`, method, params, respond }

  return { fail, request, respond }
}

/** The single `value` this request was answered with. */
const answeredValue = (respond: ReturnType<typeof vi.fn>): string =>
  (respond.mock.calls[0]?.[0] as { value: string }).value

/** The handlers answer off a promise chain, so let the microtasks drain. */
const settle = () => new Promise(resolve => setTimeout(resolve, 0))

beforeEach(() => {
  __resetAgentReadRequests()
  terminal.read.mockReset()
  terminal.read.mockReturnValue(null)
})

afterEach(() => __resetAgentReadRequests())

describe('preview.read', () => {
  it('answers empty when nothing is registered, rather than stalling the tool', async () => {
    const { request, respond } = makeRequest('preview.read')

    expect(answerAgentBridgeRequest(request, null)).toBe(true)
    await settle()

    expect(respond).toHaveBeenCalledWith({ value: '' })
  })

  it('serialises the reader result as JSON and forwards the tool windowing', async () => {
    const reader = vi.fn().mockResolvedValue({ text: 'hello', title: 'Docs' })

    registerPreviewReader(reader)

    const { request, respond } = makeRequest('preview.read', { count: 200, start: 10 })

    answerAgentBridgeRequest(request, null)
    await settle()

    expect(reader).toHaveBeenCalledWith({ count: 200, start: 10 })
    expect(respond).toHaveBeenCalledWith({ value: '{"text":"hello","title":"Docs"}' })
  })

  // The tool sends bare ints or nothing at all; a non-numeric value must not
  // reach the reader as a window it would then clamp against.
  it('drops a non-numeric window instead of forwarding it', async () => {
    const reader = vi.fn().mockReturnValue(null)

    registerPreviewReader(reader)
    answerAgentBridgeRequest(makeRequest('preview.read', { count: null, start: 'top' }).request, null)
    await settle()

    expect(reader).toHaveBeenCalledWith({ count: undefined, start: undefined })
  })

  it('answers empty when the reader throws (a surface still booting)', async () => {
    registerPreviewReader(() => {
      throw new Error('webview not ready')
    })

    const { request, respond } = makeRequest('preview.read')

    answerAgentBridgeRequest(request, null)
    await settle()

    expect(respond).toHaveBeenCalledWith({ value: '' })
  })
})

// The one blocking bridge universal can actually SATISFY today: it owns a real
// PTY terminal. Unlike the others it has no registry seam — the reader is
// resolved per-read from the active tab, so there is nothing to register.
describe('terminal.read', () => {
  it('answers empty when no terminal is mounted, rather than blocking the tool', async () => {
    const { request, respond } = makeRequest('terminal.read')

    answerAgentBridgeRequest(request, null)
    await settle()

    expect(respond).toHaveBeenCalledWith({ value: '' })
  })

  it('serialises the active terminal and forwards the tool windowing', async () => {
    const result = { cursor_row: 2, end: 3, start: 0, text: 'ok', total_lines: 3, viewport_rows: 3 }

    terminal.read.mockReturnValue(result)

    const { request, respond } = makeRequest('terminal.read', { count: 200, start: 10 })

    answerAgentBridgeRequest(request, null)
    await settle()

    expect(terminal.read).toHaveBeenCalledWith({ count: 200, start: 10 })
    expect(respond).toHaveBeenCalledWith({ value: JSON.stringify(result) })
  })

  it('answers empty when the reader throws — a broken pane must not stall the agent', async () => {
    terminal.read.mockImplementation(() => {
      throw new Error('xterm gone')
    })

    const { request, respond } = makeRequest('terminal.read')

    answerAgentBridgeRequest(request, null)
    await settle()

    expect(respond).toHaveBeenCalledWith({ value: '' })
  })
})

describe('window.read', () => {
  it('answers empty when the platform cannot enumerate windows', async () => {
    const { request, respond } = makeRequest('window.read')

    answerAgentBridgeRequest(request, null)
    await settle()

    expect(respond).toHaveBeenCalledWith({ value: '' })
  })

  it('serialises a registered reader answer', async () => {
    registerWindowBelowReader(() => ({ platform: 'linux', window: { app: 'Firefox' } }))

    const { request, respond } = makeRequest('window.read')

    answerAgentBridgeRequest(request, null)
    await settle()

    expect(respond).toHaveBeenCalledWith({ value: '{"platform":"linux","window":{"app":"Firefox"}}' })
  })
})

describe('reader registration', () => {
  it('unregisters idempotently, so a stale disposer cannot unseat a newer reader', async () => {
    const first = vi.fn().mockReturnValue({ a: 1 })
    const dispose = registerPreviewReader(first)
    const second = vi.fn().mockReturnValue({ b: 2 })

    registerPreviewReader(second)
    dispose()

    const { request, respond } = makeRequest('preview.read')

    answerAgentBridgeRequest(request, null)
    await settle()

    expect(second).toHaveBeenCalled()
    expect(respond).toHaveBeenCalledWith({ value: '{"b":2}' })
  })
})

/**
 * The DRIVE pair answers "unregistered" differently from the READ trio
 * (MJXHRM-472), and that asymmetry is the thing under test here.
 */
describe('preview.act', () => {
  it('answers a shaped refusal when no actor is registered, not an empty string', async () => {
    const { request, respond } = makeRequest('preview.act', { action: 'click', selector: '#go' })

    answerAgentBridgeRequest(request, null)
    await settle()

    const answer = JSON.parse(answeredValue(respond)) as { error: string; success: boolean }

    expect(answer.success).toBe(false)
    // Assert the fact only THIS branch can state: nothing happened to a page,
    // because there is no page. A generic "error" substring would also match a
    // thrown-actor answer.
    expect(answer.error).toContain('no in-app browser pane')
    expect(answer.error).toContain('Nothing was clicked or typed')
  })

  it('hands the actor the whole tool call minus the envelope, plus the session ctx', async () => {
    const actor = vi.fn().mockReturnValue({ url: 'about:blank' })

    registerPreviewActor(actor)

    const { request, respond } = makeRequest('preview.act', {
      action: 'type',
      selector: '#q',
      session_id: 'sess-7',
      submit: true,
      text: 'hi'
    })

    answerAgentBridgeRequest(request, 'sess-7')
    await settle()

    expect(actor).toHaveBeenCalledWith(
      { action: 'type', selector: '#q', submit: true, text: 'hi' },
      { sessionId: 'sess-7' }
    )
    expect(respond).toHaveBeenCalledWith({ value: JSON.stringify({ url: 'about:blank' }) })
  })

  // A throwing actor reports ITS error, not the unsupported text: the surface
  // exists, it just failed. Desktop's bridge answers the same shape.
  it('answers the actor’s own error when it throws', async () => {
    registerPreviewActor(() => {
      throw new Error('no preview mounted')
    })

    const { request, respond } = makeRequest('preview.act', { action: 'click' })

    answerAgentBridgeRequest(request, null)
    await settle()

    expect(respond).toHaveBeenCalledWith({
      value: JSON.stringify({ error: 'no preview mounted', success: false })
    })
  })

  // An actor that resolves to nothing is not "it worked": fall back to the same
  // refusal rather than the empty string the tool misreads as a timeout.
  it('answers the refusal when a registered actor resolves to null', async () => {
    registerPreviewActor(() => null)

    const { request, respond } = makeRequest('preview.act', { action: 'click', selector: '#go' })

    answerAgentBridgeRequest(request, null)
    await settle()

    expect((JSON.parse(answeredValue(respond)) as { success: boolean }).success).toBe(false)
  })

  /**
   * Every mounted WebView sees the same request, so the window that is not
   * looking at the named session must stay SILENT — answering would race the
   * window that owns the surface. Silent means: claimed (so the channel does not
   * answer -32601 on its behalf) but not answered.
   */
  it('stays silent in a window that is not looking at the named session', async () => {
    const actor = vi.fn().mockReturnValue({ url: 'about:blank' })

    registerPreviewActor(actor)

    const { request, respond } = makeRequest('preview.act', { action: 'click', session_id: 'sess-7' })

    expect(answerAgentBridgeRequest(request, 'sess-OTHER')).toBe(true)
    await settle()

    expect(actor).not.toHaveBeenCalled()
    expect(respond).not.toHaveBeenCalled()
  })
})

describe('tour', () => {
  it('answers a shaped refusal when no driver is registered, not an empty string', async () => {
    const { request, respond } = makeRequest('tour', { action: 'start' })

    answerAgentBridgeRequest(request, null)
    await settle()

    const answer = JSON.parse(answeredValue(respond)) as { error: string; success: boolean }

    expect(answer.success).toBe(false)
    expect(answer.error).toContain('cannot run guided tours')
    expect(answer.error).toContain('Nothing was highlighted')
  })

  it('hands the driver the tour call and returns its outcome', async () => {
    const driver = vi.fn().mockResolvedValue({ matched: 2, step: 0 })

    registerTourDriver(driver)

    const { request, respond } = makeRequest('tour', { action: 'targets', selector: '.rail', surface: 'app' })

    answerAgentBridgeRequest(request, null)
    await settle()

    expect(driver).toHaveBeenCalledWith({ action: 'targets', selector: '.rail', surface: 'app' }, { sessionId: null })
    expect(respond).toHaveBeenCalledWith({ value: JSON.stringify({ matched: 2, step: 0 }) })
  })

  it('unregisters idempotently, without clobbering a replacement', async () => {
    const first = vi.fn().mockReturnValue({ from: 'first' })
    const unregisterFirst = registerTourDriver(first)
    const second = vi.fn().mockReturnValue({ from: 'second' })

    registerTourDriver(second)
    unregisterFirst()

    const { request, respond } = makeRequest('tour', { action: 'show' })

    answerAgentBridgeRequest(request, null)
    await settle()

    expect(second).toHaveBeenCalled()
    expect(respond).toHaveBeenCalledWith({ value: JSON.stringify({ from: 'second' }) })
  })
})

describe('methods this module does not own', () => {
  // Declining is what makes the channel answer -32601 in the same tick. Claiming
  // a card method here would swallow it and leave the agent parked.
  it('declines the card and vault methods', () => {
    for (const method of ['approval', 'clarify', 'mcp.setup', 'secret', 'sudo', 'vault.code']) {
      expect(answerAgentBridgeRequest(makeRequest(method).request, null)).toBe(false)
    }
  })
})
