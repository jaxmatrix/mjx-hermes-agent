/**
 * These frames park a running agent tool for 30-45s, so the property that
 * matters is not "we answer well" but "we ALWAYS answer" — including with no
 * reader registered, and when the reader throws.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// vi.hoisted, not a bare `let`: the module under test registers its listener at
// IMPORT time, so the mock factory runs before a normal top-level binding is
// initialised.
const stream = vi.hoisted(() => ({ route: null as ((event: { payload?: unknown; type: string }) => void) | null }))

vi.mock('@/store/gateway', () => ({
  addGatewayEventListener: (listener: (event: { payload?: unknown; type: string }) => void) => {
    stream.route = listener

    return () => {
      stream.route = null
    }
  },
  requestGateway: vi.fn().mockResolvedValue({ status: 'ok' })
}))

import { requestGateway } from '@/store/gateway'

import {
  __resetAgentReadRequests,
  registerPreviewActor,
  registerPreviewReader,
  registerTourDriver,
  registerWindowBelowReader
} from './agent-read-requests'

const rpc = vi.mocked(requestGateway)

const send = (type: string, payload: Record<string, unknown>) => stream.route?.({ type, payload })

/** The responder answers off a promise chain, so let the microtasks drain. */
const settle = () => new Promise(resolve => setTimeout(resolve, 0))

beforeEach(() => {
  __resetAgentReadRequests()
  rpc.mockClear()
  rpc.mockResolvedValue({ status: 'ok' })
})

afterEach(() => __resetAgentReadRequests())

describe('preview.read.request', () => {
  it('answers empty when nothing is registered, rather than stalling the tool', async () => {
    send('preview.read.request', { request_id: 'r1' })
    await settle()

    expect(rpc).toHaveBeenCalledWith('preview.read.respond', { request_id: 'r1', text: '' })
  })

  it('serialises the reader result as JSON and forwards the tool windowing', async () => {
    const reader = vi.fn().mockResolvedValue({ text: 'hello', title: 'Docs' })
    registerPreviewReader(reader)

    send('preview.read.request', { request_id: 'r2', start: 10, count: 200 })
    await settle()

    expect(reader).toHaveBeenCalledWith({ start: 10, count: 200 })
    expect(rpc).toHaveBeenCalledWith('preview.read.respond', {
      request_id: 'r2',
      text: '{"text":"hello","title":"Docs"}'
    })
  })

  it('passes undefined windowing through when the tool asked for the whole page', async () => {
    const reader = vi.fn().mockReturnValue(null)
    registerPreviewReader(reader)

    send('preview.read.request', { request_id: 'r3' })
    await settle()

    expect(reader).toHaveBeenCalledWith({ start: undefined, count: undefined })
  })

  it('answers empty when the reader throws (a surface still booting)', async () => {
    registerPreviewReader(() => {
      throw new Error('webview not ready')
    })

    send('preview.read.request', { request_id: 'r4' })
    await settle()

    expect(rpc).toHaveBeenCalledWith('preview.read.respond', { request_id: 'r4', text: '' })
  })

  it('ignores a frame with no request_id — there is nothing to answer', async () => {
    send('preview.read.request', {})
    await settle()

    expect(rpc).not.toHaveBeenCalled()
  })
})

describe('window.read.request', () => {
  it('answers on its own method, empty when the platform cannot enumerate windows', async () => {
    send('window.read.request', { request_id: 'w1' })
    await settle()

    expect(rpc).toHaveBeenCalledWith('window.read.respond', { request_id: 'w1', text: '' })
  })

  it('serialises a registered reader answer', async () => {
    registerWindowBelowReader(() => ({ platform: 'linux', window: { app: 'Firefox' } }))

    send('window.read.request', { request_id: 'w2' })
    await settle()

    expect(rpc).toHaveBeenCalledWith('window.read.respond', {
      request_id: 'w2',
      text: '{"platform":"linux","window":{"app":"Firefox"}}'
    })
  })
})

describe('expiry', () => {
  it('drops a request the tool already gave up on instead of answering into the void', async () => {
    let release: (value: unknown) => void = () => {}
    registerPreviewReader(() => new Promise(resolve => void (release = resolve)))

    send('preview.read.request', { request_id: 'r5' })
    send('preview.read.expire', { request_id: 'r5' })
    release({ text: 'too late' })
    await settle()

    expect(rpc).not.toHaveBeenCalled()
  })

  it('leaves an unrelated in-flight request alone', async () => {
    send('window.read.expire', { request_id: 'other' })
    send('window.read.request', { request_id: 'w3' })
    await settle()

    expect(rpc).toHaveBeenCalledWith('window.read.respond', { request_id: 'w3', text: '' })
  })
})

describe('reader registration', () => {
  it('unregisters idempotently, so a stale disposer cannot unseat a newer reader', async () => {
    const first = vi.fn().mockReturnValue({ a: 1 })
    const dispose = registerPreviewReader(first)
    const second = vi.fn().mockReturnValue({ b: 2 })
    registerPreviewReader(second)

    dispose()
    send('preview.read.request', { request_id: 'r6' })
    await settle()

    expect(second).toHaveBeenCalled()
    expect(rpc).toHaveBeenCalledWith('preview.read.respond', { request_id: 'r6', text: '{"b":2}' })
  })
})

// --- preview.act / tour (MJXHRM-444) ---------------------------------------
//
// The 08-20 additions join the same blocking family. Both are already in the
// gateway's `_block` expire allowlist, so their frames — request AND expire —
// arrive today and had no listener at all: the agent's drive_preview and tour
// tools sat blocked for their full timeout on every call.

describe('preview.act.request', () => {
  it('answers empty when no actor is registered, rather than parking the tool for 45s', async () => {
    send('preview.act.request', { request_id: 'a1', action: 'click', selector: '#go' })
    await settle()

    expect(rpc).toHaveBeenCalledWith('preview.act.respond', { request_id: 'a1', text: '' })
  })

  // The payload IS the tool call. Forwarding it wholesale is what lets a verb
  // or argument added backend-side reach a registered actor with no change here
  // — so the actor must receive the arguments, and NOT the envelope key.
  it('hands the actor the whole tool call minus the envelope', async () => {
    const actor = vi.fn().mockReturnValue({ url: 'about:blank' })

    registerPreviewActor(actor)
    send('preview.act.request', { request_id: 'a2', action: 'type', selector: '#q', text: 'hi', submit: true })
    await settle()

    expect(actor).toHaveBeenCalledWith({ action: 'type', selector: '#q', text: 'hi', submit: true })
    expect(rpc).toHaveBeenCalledWith('preview.act.respond', {
      request_id: 'a2',
      text: JSON.stringify({ url: 'about:blank' })
    })
  })

  it('answers empty when the actor throws — a broken surface must not become a stalled agent', async () => {
    registerPreviewActor(() => {
      throw new Error('no preview mounted')
    })
    send('preview.act.request', { request_id: 'a3', action: 'click' })
    await settle()

    expect(rpc).toHaveBeenCalledWith('preview.act.respond', { request_id: 'a3', text: '' })
  })

  it('drops a request the gateway already expired instead of answering a tool that gave up', async () => {
    let release: (value: unknown) => void = () => {}

    registerPreviewActor(() => new Promise(resolve => (release = resolve)))
    send('preview.act.request', { request_id: 'a4', action: 'click' })
    send('preview.act.expire', { request_id: 'a4' })
    release({ url: 'late' })
    await settle()

    expect(rpc).not.toHaveBeenCalled()
  })

  it('ignores a frame with no request id — there is nothing to answer', async () => {
    registerPreviewActor(() => ({ url: 'x' }))
    send('preview.act.request', { action: 'click' })
    await settle()

    expect(rpc).not.toHaveBeenCalled()
  })
})

describe('tour.request', () => {
  it('answers empty when no driver is registered', async () => {
    send('tour.request', { request_id: 't1', action: 'start' })
    await settle()

    expect(rpc).toHaveBeenCalledWith('tour.respond', { request_id: 't1', text: '' })
  })

  it('hands the driver the tour call and returns its outcome', async () => {
    const driver = vi.fn().mockResolvedValue({ matched: 2, step: 0 })

    registerTourDriver(driver)
    send('tour.request', { request_id: 't2', action: 'targets', surface: 'app', selector: '.rail' })
    await settle()

    expect(driver).toHaveBeenCalledWith({ action: 'targets', surface: 'app', selector: '.rail' })
    expect(rpc).toHaveBeenCalledWith('tour.respond', {
      request_id: 't2',
      text: JSON.stringify({ matched: 2, step: 0 })
    })
  })

  it('drops a request the gateway already expired', async () => {
    let release: (value: unknown) => void = () => {}

    registerTourDriver(() => new Promise(resolve => (release = resolve)))
    send('tour.request', { request_id: 't3', action: 'next' })
    send('tour.expire', { request_id: 't3' })
    release({ step: 1 })
    await settle()

    expect(rpc).not.toHaveBeenCalled()
  })

  // Both registrars hand back an unregister; a stale one must not tear down a
  // reader that replaced it.
  it('unregisters idempotently, without clobbering a replacement', async () => {
    const first = vi.fn().mockReturnValue({ from: 'first' })
    const unregisterFirst = registerTourDriver(first)
    const second = vi.fn().mockReturnValue({ from: 'second' })

    registerTourDriver(second)
    unregisterFirst()

    send('tour.request', { request_id: 't4', action: 'show' })
    await settle()

    expect(second).toHaveBeenCalled()
    expect(rpc).toHaveBeenCalledWith('tour.respond', { request_id: 't4', text: JSON.stringify({ from: 'second' }) })
  })
})
