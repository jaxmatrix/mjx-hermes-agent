import { beforeEach, describe, expect, it, vi } from 'vitest'

const evalInGuest = vi.fn()
const browserBack = vi.fn(() => Promise.resolve())
const browserForward = vi.fn(() => Promise.resolve())
const browserReload = vi.fn(() => Promise.resolve())

vi.mock('@/lib/browser/host', () => ({ evalInGuest }))

vi.mock('@/store/browser', async () => {
  const { atom } = await import('@/store/atom')

  return {
    $browserState: atom({ title: 'Example', url: 'https://example.com/' }),
    browserBack,
    browserForward,
    browserReload
  }
})

const { __resetActEngine, actInGuest, ENGINE_VERSION } = await import('./actor')

/** The engine hands back a JSON *value*; ours is a JSON string of JSON. */
const doubled = (value: unknown) => JSON.stringify(JSON.stringify(value))

/** First call is always the version probe. */
function armEngine(present = true): void {
  evalInGuest.mockResolvedValueOnce(doubled(present))
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useRealTimers()
  __resetActEngine()
})

describe('actInGuest', () => {
  it('injects the engine once and then only probes for it', async () => {
    // Miss: probe (skipped, no injectedFor) → inject → run.
    evalInGuest.mockResolvedValueOnce('') // the injection
    evalInGuest.mockResolvedValueOnce(doubled({ action: 'elements', elements: [], success: true }))

    await actInGuest({ action: 'elements' })
    expect(evalInGuest).toHaveBeenCalledTimes(2)

    // Hit: probe → run. No second injection.
    evalInGuest.mockClear()
    armEngine()
    evalInGuest.mockResolvedValueOnce(doubled({ action: 'elements', delta: { added: [] }, success: true }))

    await actInGuest({ action: 'elements' })

    expect(evalInGuest).toHaveBeenCalledTimes(2)
    expect(evalInGuest.mock.calls[0][0]).toContain(`v === ${ENGINE_VERSION}`)
  })

  it('does NOT pay the settle for a plain inventory', async () => {
    // Making every verb pay the settle turns this red: a read loop would cost
    // 350 ms and a rescan per call for nothing.
    evalInGuest.mockResolvedValueOnce('')
    evalInGuest.mockResolvedValueOnce(doubled({ action: 'elements', elements: [], success: true }))

    await actInGuest({ action: 'elements' })

    expect(evalInGuest).toHaveBeenCalledTimes(2)
  })

  it('re-inventories after a MUTATING verb, and folds the delta in', async () => {
    evalInGuest.mockResolvedValueOnce('')
    evalInGuest.mockResolvedValueOnce(doubled({ action: 'click', success: true }))
    evalInGuest.mockResolvedValueOnce(
      doubled({ action: 'elements', delta: { added: [{ label: 'Sign in', ref: 'btn-sign-in', role: 'button' }] }, success: true })
    )

    const result = await actInGuest({ action: 'click', ref: 'btn-sign-in' })

    expect(result.success).toBe(true)
    expect(result.ref).toBe('btn-sign-in')
    expect(result.delta?.added).toHaveLength(1)
    expect(evalInGuest).toHaveBeenCalledTimes(3)
  })

  it('routes back/forward/reload to the HOST and reports stale refs', async () => {
    for (const [action, spy] of [
      ['back', browserBack],
      ['forward', browserForward],
      ['reload', browserReload]
    ] as const) {
      const result = await actInGuest({ action })

      expect(spy).toHaveBeenCalled()
      expect(result.stale).toBe(true)
      expect(result.success).toBe(true)
    }

    // A navigation never touches the in-page engine.
    expect(evalInGuest).not.toHaveBeenCalled()
  })

  it('answers a shaped refusal when the engine throws — never an empty string', async () => {
    evalInGuest.mockRejectedValue(new Error('the page went away'))

    const result = await actInGuest({ action: 'click', ref: 'btn-x' })

    expect(result.success).toBe(false)
    expect(result.error).toContain('the page went away')
    expect(result.action).toBe('click')
  })

  it('reports a page that gave back something unreadable', async () => {
    evalInGuest.mockResolvedValueOnce('')
    evalInGuest.mockResolvedValueOnce(JSON.stringify('null'))

    const result = await actInGuest({ action: 'hover', ref: 'btn-x' })

    expect(result.success).toBe(false)
    expect(result.error).toContain('nothing')
  })
})
