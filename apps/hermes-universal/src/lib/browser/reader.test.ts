import { beforeEach, describe, expect, it, vi } from 'vitest'

const evalInGuest = vi.fn()

vi.mock('@/lib/browser/host', () => ({ evalInGuest }))

const { $activePreviewPath, $previewTabs, BROWSER_TAB_PATH } = await import('@/store/preview')
const { PREVIEW_READ_MAX_CHARS, readActiveBrowserPage, windowText } = await import('./reader')

function openBrowserTab(): void {
  $previewTabs.set([{ name: 'example.com', path: BROWSER_TAB_PATH }])
  $activePreviewPath.set(BROWSER_TAB_PATH)
}

/** The engine hands back a JSON *value*; ours is a JSON string of JSON. */
const doubled = (value: unknown) => JSON.stringify(JSON.stringify(value))

beforeEach(() => {
  vi.clearAllMocks()
  $previewTabs.set([])
  $activePreviewPath.set(null)
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
    $previewTabs.set([{ name: 'a.ts', path: '/repo/a.ts' }])
    $activePreviewPath.set('/repo/a.ts')

    const answer = await readActiveBrowserPage()

    expect(answer?.kind).toBe('file')
    expect(answer?.note).toContain('read_file')
  })

  it('points an artifact tab at the conversation that produced it', async () => {
    $previewTabs.set([{ name: 'Chart', path: 'artifact:abc' }])
    $activePreviewPath.set('artifact:abc')

    expect((await readActiveBrowserPage())?.note).toContain('conversation')
  })

  it('reports the FULL length so the agent can page', async () => {
    openBrowserTab()
    evalInGuest.mockResolvedValue(
      doubled({ f: 100, n: 50_000, s: 'hello', ti: 'Example', u: 'https://example.com/' })
    )

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
