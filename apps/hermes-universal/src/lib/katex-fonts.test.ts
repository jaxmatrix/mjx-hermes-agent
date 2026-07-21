import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// jsdom has no FontFaceSet — stand one in so the warm-up is observable.
function stubFonts(ready: Promise<unknown> = Promise.resolve()) {
  const load = vi.fn().mockResolvedValue([])

  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: { load, ready }
  })

  return load
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

beforeEach(() => {
  vi.resetModules()
  vi.stubGlobal('requestIdleCallback', undefined)
})

afterEach(() => {
  vi.unstubAllGlobals()
  Reflect.deleteProperty(document, 'fonts')
})

describe('warmKatexFonts', () => {
  it('loads every KaTeX face declared by katex.min.css', async () => {
    const load = stubFonts()
    const { warmKatexFonts } = await import('./katex-fonts')

    warmKatexFonts()
    await flush()

    // 20 @font-face rules in katex.min.css — all font-display: block, which is
    // exactly why they must be resident before the first equation paints.
    expect(load).toHaveBeenCalledTimes(20)
    expect(load).toHaveBeenCalledWith('400 16px KaTeX_Main')
    expect(load).toHaveBeenCalledWith('italic 400 16px KaTeX_Math')
    expect(load).toHaveBeenCalledWith('400 16px KaTeX_Size4')
  })

  it('waits for document.fonts.ready before loading', async () => {
    let release: (value: unknown) => void = () => {}
    const load = stubFonts(new Promise(resolve => (release = resolve)))
    const { warmKatexFonts } = await import('./katex-fonts')

    warmKatexFonts()
    await flush()
    // In dev the stylesheet is injected after this module runs; loading before
    // the @font-face rules exist would match nothing and silently no-op.
    expect(load).not.toHaveBeenCalled()

    release(undefined)
    await flush()
    expect(load).toHaveBeenCalledTimes(20)
  })

  it('only warms once', async () => {
    const load = stubFonts()
    const { warmKatexFonts } = await import('./katex-fonts')

    warmKatexFonts()
    warmKatexFonts()
    await flush()

    expect(load).toHaveBeenCalledTimes(20)
  })

  it('is a no-op where the font API is missing', async () => {
    Reflect.deleteProperty(document, 'fonts')
    const { warmKatexFonts } = await import('./katex-fonts')

    expect(() => warmKatexFonts()).not.toThrow()
  })
})
