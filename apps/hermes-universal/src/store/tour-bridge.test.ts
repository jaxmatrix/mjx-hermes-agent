/**
 * End-to-end for the agent-driven tour (MJXHRM-473): a real `tour.request`
 * frame off the gateway stream, through `store/agent-read-requests.ts`, into
 * the driver this module registers, into the REAL `lib/tour` engine, and back
 * out as the `tour.respond` payload the tool reads.
 *
 * Nothing about `lib/tour` is mocked on purpose. The half worth asserting here
 * is the seam — that the wire frame's `action`/`step_index`/`surface` reach the
 * engine as the right action, that the answer is the shaped JSON the tool
 * parses rather than the empty string that reads as "no GUI window answered",
 * and that importing the engine (driver.js + two stylesheets) actually
 * resolves. `lib/tour/engine.test.ts` covers the engine's own behaviour against
 * a recording fake.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// vi.hoisted, not a bare `let`: agent-read-requests registers its listener at
// IMPORT time, so the mock factory runs before a normal binding is initialised.
const stream = vi.hoisted(() => ({ route: null as ((event: { payload?: unknown; type: string }) => void) | null }))

const windows = vi.hoisted(() => ({ owns: true }))

vi.mock('@/store/gateway', () => ({
  addGatewayEventListener: (listener: (event: { payload?: unknown; type: string }) => void) => {
    stream.route = listener

    return () => {
      stream.route = null
    }
  },
  requestGateway: vi.fn().mockResolvedValue({ status: 'ok' })
}))

vi.mock('@/store/windows', () => ({
  isSecondaryWindow: () => !windows.owns,
  ownsPersistedAppState: () => windows.owns
}))

// The engine reveals panes through MJXHRM-472's bridge; the tree it drives is
// not what this file is about, so record the call instead of mounting a shell.
const panes = vi.hoisted(() => ({ revealed: [] as string[] }))

vi.mock('@/store/pane-focus', () => ({
  revealBridgePane: (pane: string) => {
    panes.revealed.push(pane)

    return true
  }
}))

import { requestGateway } from '@/store/gateway'

import { __resetAgentReadRequests } from './agent-read-requests'
import { installTourDriver } from './tour-bridge'

const rpc = vi.mocked(requestGateway)

const send = (payload: Record<string, unknown>) => stream.route?.({ payload, type: 'tour.request' })

/** Wait for the answer rather than for a fixed delay: the first request in the
 *  file pays for the dynamic `import('@/lib/tour')` — engine, driver.js and two
 *  stylesheets through vitest's transform — which is slower than any tick count
 *  worth hard-coding, and a sleep tuned to it would go flaky on a cold machine. */
async function settle(): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (rpc.mock.calls.some(([method]) => method === 'tour.respond')) {
      return
    }

    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

/** The `text` of the single `tour.respond` sent so far, parsed. */
function answer(): Record<string, unknown> {
  const call = rpc.mock.calls.find(([method]) => method === 'tour.respond')

  expect(call, 'no tour.respond was sent').toBeDefined()

  const text = (call?.[1] as { text: string }).text

  expect(text, 'answered with the empty string, which the tool reads as "no GUI window answered"').not.toBe('')

  return JSON.parse(text) as Record<string, unknown>
}

let unregister = () => {}

beforeEach(() => {
  windows.owns = true
  panes.revealed = []
  __resetAgentReadRequests()
  rpc.mockClear()
  rpc.mockResolvedValue({ status: 'ok' })

  document.body.innerHTML = `
    <nav data-tour="sidebar" aria-label="Sessions"><button id="new-chat" aria-label="New chat">New</button></nav>
    <main><form data-tour="composer" aria-label="Composer"><textarea aria-label="Message"></textarea></form></main>
  `
  // jsdom lays nothing out — every rect is 0x0, which the collector's
  // visibility filter (rightly) drops. Give elements a real-looking box.
  Element.prototype.getBoundingClientRect = () =>
    ({ bottom: 40, height: 32, left: 8, right: 128, top: 8, width: 120, x: 8, y: 8 }) as DOMRect

  unregister = installTourDriver()
})

afterEach(async () => {
  // A tour outlives the test that started it: `run-tour.ts` holds ONE module-
  // level driver, and its keep-alive MutationObserver re-drives the live step
  // on any DOM change — so the next test's `document.body.innerHTML` reveals
  // the previous test's pane. That is the correct product behaviour (a tour
  // survives the surface re-rendering under it), which makes tearing it down
  // the test's job.
  const { stopTour } = await import('@/lib/tour')

  await stopTour()
  unregister()
  __resetAgentReadRequests()
})

describe('tour.request → the app-surface engine', () => {
  it('answers `targets` with the durable data-tour handles', async () => {
    send({ action: 'targets', request_id: 't-targets' })
    await settle()

    const result = answer()
    const targets = result.targets as { selector: string; stable: boolean }[]

    expect(result.success).toBe(true)
    // Seeded to DISAGREE: the DOM also carries an id, an aria-label and a
    // positional-only <textarea>, so "found something" is not the assertion —
    // "found the data-tour handles, marked stable" is.
    expect(targets.map(target => target.selector)).toEqual(
      expect.arrayContaining(['[data-tour="sidebar"]', '[data-tour="composer"]'])
    )
    expect(targets.find(target => target.selector === '[data-tour="composer"]')?.stable).toBe(true)
  })

  it('names the selector that did not match, and offers the re-scan', async () => {
    send({ action: 'show', request_id: 't-bad', selector: '[data-tour="no-such-thing"]' })
    await settle()

    const result = answer()

    expect(result.success).toBe(false)
    // The error IS the useful answer: the model has to learn WHICH selector
    // missed, or it retries the same one.
    expect(result.error).toContain('[data-tour="no-such-thing"]')
    expect(result.hint).toContain('targets')
  })

  it('maps step_index onto the step the tour opens at, and reveals its pane', async () => {
    send({
      action: 'start',
      request_id: 't-start',
      step_index: 1,
      steps: [
        { selector: '[data-tour="sidebar"]', title: 'Sessions' },
        { pane: 'files', selector: '[data-tour="composer"]', title: 'Composer' }
      ]
    })
    await settle()

    const result = answer()

    // 1, not 0: `step_index` is the wire name for the engine's `startAt`, and
    // dropping it would still answer success on step 0.
    expect(result).toMatchObject({ activeStep: 1, steps: 2, success: true })
    expect(panes.revealed).toEqual(['files'])
  })

  it('refuses the preview surface rather than touring the app chrome', async () => {
    send({ action: 'targets', request_id: 't-preview', surface: 'preview' })
    await settle()

    const result = answer()

    // A wrong answer is worse than a refusal: `surface='preview'` means the
    // agent believes it is looking at a web page. MJXHRM-447 replaces this.
    expect(result.success).toBe(false)
    expect(result.error).toContain('no in-app browser pane')
    expect(result.targets).toBeUndefined()
  })

  it('reports an unknown verb instead of silently stopping', async () => {
    send({ action: 'teleport', request_id: 't-verb' })
    await settle()

    const result = answer()

    expect(result.success).toBe(false)
    expect(result.error).toContain('teleport')
  })

  it('drops an expired request instead of answering it late', async () => {
    send({ action: 'targets', request_id: 't-expire' })
    stream.route?.({ payload: { request_id: 't-expire' }, type: 'tour.expire' })
    await settle()

    expect(rpc.mock.calls.filter(([method]) => method === 'tour.respond')).toEqual([])
  })

  it('leaves the negative default in place in a window that owns no layout', async () => {
    unregister()
    __resetAgentReadRequests()
    windows.owns = false
    unregister = installTourDriver()

    send({ action: 'targets', request_id: 't-tile' })
    await settle()

    const result = answer()

    // A detached tile / satellite / Android activity screen registering would
    // answer "highlighted" while every pane step silently did nothing — so the
    // honest answer is MJXHRM-472's refusal, not a tour.
    expect(result.success).toBe(false)
    expect(result.error).toContain('cannot run guided tours')
    expect(panes.revealed).toEqual([])
  })
})
