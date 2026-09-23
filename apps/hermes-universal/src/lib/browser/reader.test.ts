import { beforeEach, describe, expect, it, vi } from 'vitest'

const evalInGuest = vi.fn()

// The rest is the browser store's: it follows the rail, so opening a Browser tab
// asks what the host can do, and sweeping one takes the (never-opened) guest down.
vi.mock('@/lib/browser/host', () => ({
  browserCapabilities: vi.fn(() => Promise.resolve({ host: 'none' })),
  closeGuest: vi.fn(() => Promise.resolve()),
  evalInGuest
}))

const { closeRightRail, openPreview } = await import('@/store/preview')
const { PREVIEW_READ_MAX_CHARS, readActiveBrowserPage, windowText } = await import('./reader')

function openBrowserTab(): void {
  openPreview({ kind: 'url', label: 'example.com', source: 'https://example.com/', url: 'https://example.com/' })
}

/** The engine hands back a JSON *value*; ours is a JSON string of JSON. */
const doubled = (value: unknown) => JSON.stringify(JSON.stringify(value))

beforeEach(() => {
  vi.clearAllMocks()
  closeRightRail()
})

describe('windowText', () => {
  it('caps a single read even when asked for more', () => {
    // Raising the cap to Infinity turns this red. That text crosses the gateway
    // into model context; the cap is the hard boundary.
    expect(windowText(1_000_000, { count: 500_000 })).toEqual({ from: 0, to: PREVIEW_READ_MAX_CHARS })
  })

  it('clamps a start past the end and a negative count', () => {
    expect(windowText(10, { start: 99 })).toEqual({ from: 10, to: 10 })
    expect(windowText(10, { count: -5 })).toEqual({ from: 0, to: 1 })
    expect(windowText(10, { start: Number.NaN })).toEqual({ from: 0, to: 10 })
  })
})

describe('readActiveBrowserPage', () => {
  it('answers null ONLY when there is no preview at all', async () => {
    expect(await readActiveBrowserPage()).toBeNull()
  })

  it('points a file tab at read_file instead of answering empty', async () => {
    openPreview({ kind: 'file', label: 'a.ts', path: '/repo/a.ts', source: '/repo/a.ts', url: 'file:///repo/a.ts' })

    const answer = await readActiveBrowserPage()

    expect(answer?.kind).toBe('file')
    expect(answer?.path).toBe('/repo/a.ts')
    expect(answer?.note).toContain('read_file')
  })

  it('points an artifact tab at the conversation that produced it', async () => {
    openPreview({ kind: 'artifact', label: 'Chart', source: 'abc', url: 'abc' })

    expect((await readActiveBrowserPage())?.note).toContain('conversation')
  })

  it('reports the FULL length so the agent can page', async () => {
    openBrowserTab()
    evalInGuest.mockResolvedValue(doubled({ f: 100, n: 50_000, s: 'hello', ti: 'Example', u: 'https://example.com/' }))

    expect(await readActiveBrowserPage({ count: 5, start: 100 })).toEqual({
      end: 105,
      kind: 'url',
      start: 100,
      text: 'hello',
      title: 'Example',
      total_chars: 50_000,
      url: 'https://example.com/'
    })
  })

  it('never throws: a booting page falls through to identity plus a retry note', async () => {
    openBrowserTab()
    evalInGuest.mockRejectedValue(new Error('eval timeout'))

    const answer = await readActiveBrowserPage()

    expect(answer?.kind).toBe('url')
    expect(answer?.note).toContain('retry')
    expect(answer?.text).toBe('')
  })

  it('treats a page that answered nonsense as not-loaded rather than as text', async () => {
    openBrowserTab()
    evalInGuest.mockResolvedValue(doubled({}))

    expect((await readActiveBrowserPage())?.note).toContain('retry')
  })
})
