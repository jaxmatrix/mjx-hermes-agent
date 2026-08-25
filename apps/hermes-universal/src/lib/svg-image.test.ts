import { describe, expect, it } from 'vitest'

import { normalizeSvgSize, svgSize } from './svg-image'

// Mermaid emits `width="100%"` plus a viewBox. That percentage is not an
// intrinsic size: the zoom overlay's shrink-to-fit grid collapses it, and
// `parseFloat('100%')` made a 100px PNG — so copy fell back to raw SVG text.
describe('normalizeSvgSize', () => {
  it('replaces a percentage width with the viewBox pixels', () => {
    const out = normalizeSvgSize('<svg width="100%" viewBox="0 0 640 480"></svg>')

    expect(out).toContain('width="640"')
  })

  it('fills in the height mermaid omits', () => {
    const out = normalizeSvgSize('<svg width="100%" viewBox="0 0 640 480"></svg>')

    expect(out).toContain('height="480"')
  })

  it('leaves an explicit pixel height alone', () => {
    const out = normalizeSvgSize('<svg width="100%" height="123" viewBox="0 0 640 480"></svg>')

    expect(out).toContain('height="123"')
  })

  it('is a no-op when both attrs are already pixels', () => {
    const svg = '<svg width="640" height="480" viewBox="0 0 640 480"></svg>'

    expect(normalizeSvgSize(svg)).toBe(svg)
  })

  it('is a no-op when the percentage has no viewBox to fall back on', () => {
    const svg = '<svg width="100%"></svg>'

    expect(normalizeSvgSize(svg)).toBe(svg)
  })
})

describe('svgSize', () => {
  it('does not read a percentage as pixels', () => {
    // The seed disagrees with the answer on purpose: parseFloat('100%') is 100,
    // so the pre-fix code returned 100x100 rather than the viewBox.
    expect(svgSize('<svg width="100%" height="100%" viewBox="0 0 640 480"></svg>')).toEqual({
      height: 480,
      width: 640
    })
  })

  it('prefers explicit pixel attributes over the viewBox', () => {
    expect(svgSize('<svg width="200" height="100" viewBox="0 0 640 480"></svg>')).toEqual({
      height: 100,
      width: 200
    })
  })

  it('falls back to a default when there is neither', () => {
    expect(svgSize('<svg></svg>')).toEqual({ height: 600, width: 800 })
  })
})
