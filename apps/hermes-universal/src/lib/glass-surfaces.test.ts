import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { applyGlassSurfaces, stopRailTracking } from './glass-surfaces'
import type { TranslucencyState } from './translucency-model'

const state = (patch: Partial<TranslucencyState> = {}): TranslucencyState => ({
  fade: 0,
  intensity: 0,
  material: 'under-window',
  mode: 'clear',
  scope: 'window',
  ...patch
})

const BACKED = { effectiveGlass: true, glassBacked: true }

const root = (): HTMLElement => document.documentElement
const keep = (): string => root().style.getPropertyValue('--translucency-glass-keep')
const rail = (): string => root().style.getPropertyValue('--glass-rail-edge')

beforeEach(() => {
  root().removeAttribute('style')
  root().removeAttribute('dir')

  for (const flag of ['hermesGlass', 'hermesGlassOn', 'hermesClear', 'hermesGlassScope']) {
    delete root().dataset[flag]
  }

  document.body.innerHTML = ''
  stopRailTracking()
})

afterEach(() => {
  stopRailTracking()
})

describe('applyGlassSurfaces', () => {
  it('writes nothing while translucency is off', () => {
    applyGlassSurfaces(state(), BACKED)

    expect(root().dataset.hermesGlass).toBeUndefined()
    expect(root().dataset.hermesGlassOn).toBeUndefined()
    expect(root().dataset.hermesClear).toBeUndefined()
    expect(keep()).toBe('')
  })

  it('flags clear without touching the glass flags', () => {
    applyGlassSurfaces(state({ intensity: 40, mode: 'clear' }), BACKED)

    expect(root().dataset.hermesClear).toBe('')
    expect(root().dataset.hermesGlass).toBeUndefined()
    expect(root().dataset.hermesGlassOn).toBeUndefined()
    // The tint is a glass token; clear fades the whole window natively instead.
    expect(keep()).toBe('')
  })

  it('treats glass at zero tint as OFF, not as selected', () => {
    applyGlassSurfaces(state({ intensity: 0, mode: 'glass' }), BACKED)

    expect(root().dataset.hermesGlass).toBeUndefined()
    expect(root().dataset.hermesGlassOn).toBeUndefined()
    expect(keep()).toBe('')
  })

  it('paints the field and publishes the tint while glass is active', () => {
    applyGlassSurfaces(state({ intensity: 35, mode: 'glass' }), BACKED)

    expect(root().dataset.hermesGlass).toBe('')
    expect(root().dataset.hermesGlassOn).toBe('')
    expect(root().dataset.hermesClear).toBeUndefined()
    expect(keep()).toBe('65%')
  })

  it('gives a satellite the tint and the -on flag, never the surface rewrite', () => {
    applyGlassSurfaces(state({ intensity: 35, mode: 'glass' }), { effectiveGlass: true, glassBacked: false })

    expect(root().dataset.hermesGlassOn).toBe('')
    expect(root().dataset.hermesGlass).toBeUndefined()
    expect(keep()).toBe('65%')
  })

  it('believes the NATIVE answer over its own request', () => {
    applyGlassSurfaces(state({ intensity: 35, mode: 'glass' }), { effectiveGlass: false, glassBacked: true })

    // The material was refused, so the page must not thin itself over nothing.
    expect(root().dataset.hermesGlass).toBeUndefined()
    expect(root().dataset.hermesGlassOn).toBe('')
  })

  it('scopes to the sidebar only while glass is actually on', () => {
    applyGlassSurfaces(state({ intensity: 35, mode: 'glass', scope: 'sidebar' }), BACKED)

    expect(root().dataset.hermesGlassScope).toBe('sidebar')

    applyGlassSurfaces(state({ intensity: 35, mode: 'clear', scope: 'sidebar' }), BACKED)

    expect(root().dataset.hermesGlassScope).toBeUndefined()
  })

  it('clears every flag on the way back down', () => {
    applyGlassSurfaces(state({ intensity: 35, mode: 'glass', scope: 'sidebar' }), BACKED)
    applyGlassSurfaces(state(), BACKED)

    expect(root().dataset.hermesGlass).toBeUndefined()
    expect(root().dataset.hermesGlassOn).toBeUndefined()
    expect(root().dataset.hermesGlassScope).toBeUndefined()
    expect(keep()).toBe('')
    expect(rail()).toBe('')
  })
})

describe('rail tracking', () => {
  class FakeResizeObserver {
    observe = vi.fn()
    disconnect = vi.fn()
    unobserve = vi.fn()
  }

  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1000, writable: true })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function mountRail(left: number, right: number): HTMLElement {
    const pane = document.createElement('div')
    pane.dataset.paneId = 'sessions'
    pane.getBoundingClientRect = () => ({ left, right }) as DOMRect
    document.body.appendChild(pane)

    return pane
  }

  it('measures the rail from the right edge in LTR', () => {
    mountRail(0, 237)
    applyGlassSurfaces(state({ intensity: 35, mode: 'glass', scope: 'sidebar' }), BACKED)

    expect(rail()).toBe('237px')
  })

  it('measures from the other edge in RTL', () => {
    root().dir = 'rtl'
    mountRail(763, 1000)
    applyGlassSurfaces(state({ intensity: 35, mode: 'glass', scope: 'sidebar' }), BACKED)

    expect(rail()).toBe('237px')
  })

  it('falls back to a fully opaque field with no rail on screen', () => {
    applyGlassSurfaces(state({ intensity: 35, mode: 'glass', scope: 'sidebar' }), BACKED)

    expect(rail()).toBe('0px')
  })

  it('re-acquires a rail that was detached and rebuilt', () => {
    const first = mountRail(0, 237)

    applyGlassSurfaces(state({ intensity: 35, mode: 'glass', scope: 'sidebar' }), BACKED)

    expect(rail()).toBe('237px')

    first.remove()
    mountRail(0, 300)
    // A resize fires the same measurement the observer would.
    window.dispatchEvent(new Event('resize'))

    expect(rail()).toBe('300px')
  })
})

// jsdom applies no stylesheet, so the one-painter contract is asserted against
// the source. These four declarations are the whole rule: thin the surface
// TOKENS (the field surfaces nest, so painting each of them would stack the
// tint four times) and leave the terminal's own token opaque.
describe('the glass block in styles.css', () => {
  const css = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'styles.css'), 'utf8')

  const block = css.slice(css.indexOf(':root[data-hermes-glass] {'), css.indexOf(':root[data-hermes-glass] body'))

  it('thins every nested field surface', () => {
    for (const token of [
      '--ui-chat-surface-background',
      '--ui-sidebar-surface-background',
      '--ui-editor-surface-background',
      '--ui-surface-background'
    ]) {
      expect(block).toContain(`${token}: transparent;`)
    }
  })

  it('leaves the terminal canvas opaque — WebGL cannot composite page alpha', () => {
    expect(block).toContain('--ui-terminal-surface-background: var(--ui-bg-chrome);')
    expect(block).not.toContain('--ui-terminal-surface-background: transparent')
  })

  it('declares the terminal token off glass too, so nothing changes when it is off', () => {
    expect(css).toContain('--ui-terminal-surface-background: var(--ui-editor-surface-background);')
  })

  it('keeps raised and masking surfaces out of the field', () => {
    expect(css).toContain(':root[data-hermes-glass] [data-glass-opaque] {')
    expect(css).toContain(':root[data-hermes-glass] [data-glass-raised] {')
  })
})
