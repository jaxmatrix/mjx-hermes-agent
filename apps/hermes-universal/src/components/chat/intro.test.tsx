/**
 * The intro wordmark is hidden until it has been fitted to its column — and
 * after that it must INHERIT its visibility, never force it.
 *
 * A hidden tab stays mounted and is hidden with `visibility: hidden` on its
 * layer. An explicit `visible` on a descendant overrides that, so an empty main
 * chat's "HERMES AGENT" painted straight through the tab stacked on top of it —
 * a Bot Chat, or any session opened beside the main chat (MJXHRM-518).
 */

import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/app/hooks/use-config-record', () => ({ useHermesConfigRecord: () => ({ data: {} }) }))

import { Intro } from './intro'

/** jsdom does no layout: give the fill its column width and the twin its width
 *  at the reference size, which is all `fit()` reads. */
function stubLayout(columnWidth: number, naturalWidth: number): void {
  vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(columnWidth)
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ width: naturalWidth } as DOMRect)
}

const wordmark = (): HTMLElement => screen.getByLabelText('HERMES AGENT')

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the intro wordmark', () => {
  it('stays hidden until it has been measured, so it never flashes at the fallback size', () => {
    stubLayout(0, 0)

    render(<Intro />)

    expect(wordmark().style.visibility).toBe('hidden')
  })

  it('once measured, INHERITS visibility rather than forcing itself visible through a hidden tab', () => {
    // 300 / 200 × 100 = 150px — inside the clamp, so the fit is observable.
    stubLayout(300, 200)

    render(<Intro />)

    expect(wordmark().style.fontSize).toBe('150px')
    expect(wordmark().style.visibility).toBe('')
  })
})
