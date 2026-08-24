import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  backgroundMaterialFor,
  clampIntensity,
  defaultTranslucencyState,
  defaultTranslucencyValues,
  GLASS_MATERIALS,
  glassActive,
  glassMaterialForPicker,
  glassMaterialsFor,
  glassSurfaceKeep,
  hudFrostFor,
  normalizeBook,
  normalizeMaterial,
  normalizeMode,
  normalizeScope,
  normalizeState,
  resolveTranslucency,
  setTranslucencyValues,
  TRANSLUCENCY_CURVE,
  TRANSLUCENCY_MAX,
  TRANSLUCENCY_OPACITY_FLOOR,
  type TranslucencyBook,
  type TranslucencyState,
  vibrancyFor,
  windowOpacityFor
} from './translucency-model'

const state = (patch: Partial<TranslucencyState> = {}): TranslucencyState => ({
  fade: 0,
  intensity: 0,
  material: 'under-window',
  mode: 'clear',
  scope: 'window',
  ...patch
})

const book = (patch: Partial<TranslucencyBook> = {}): TranslucencyBook => ({
  base: {},
  dark: {},
  light: {},
  mode: 'glass',
  ...patch
})

describe('clampIntensity', () => {
  it('rounds, bounds and floors junk to zero', () => {
    expect(clampIntensity(42.4)).toBe(42)
    expect(clampIntensity(42.5)).toBe(43)
    expect(clampIntensity(-10)).toBe(0)
    expect(clampIntensity(140.6)).toBe(100)
    expect(clampIntensity('nonsense')).toBe(0)
    expect(clampIntensity(undefined)).toBe(0)
    expect(clampIntensity(Number.NaN)).toBe(0)
  })
})

describe('normalizeMode', () => {
  it('forces clear where glass is unsupported, whatever was saved', () => {
    expect(normalizeMode('glass', false)).toBe('clear')
    expect(normalizeMode('clear', false)).toBe('clear')
  })

  it('honours an explicit mode where glass is supported', () => {
    expect(normalizeMode('glass', true)).toBe('glass')
    expect(normalizeMode('clear', true)).toBe('clear')
  })

  it('ships glass on for a fresh profile', () => {
    expect(normalizeMode(undefined, true)).toBe('glass')
    expect(normalizeMode('nonsense', true)).toBe('glass')
  })

  it('leaves a legacy profile that was already tuned on clear', () => {
    // M-02: the one thing a default must not do is flip a window someone
    // already tuned. A non-zero v1 intensity has been rendering as clear.
    expect(normalizeMode(undefined, true, 40)).toBe('clear')
    expect(normalizeMode(undefined, true, 0)).toBe('glass')
  })
})

describe('windowOpacityFor', () => {
  it('is bit-identical to the LINEAR ramp at both endpoints', () => {
    // The curve is what the exponent buys; the endpoints must not move, or
    // raising TRANSLUCENCY_CURVE would quietly retune every saved profile.
    const linear = (lever: number) => 1 - (1 - TRANSLUCENCY_OPACITY_FLOOR) * (lever / TRANSLUCENCY_MAX)

    expect(windowOpacityFor(state({ intensity: 0 }))).toBe(linear(0))
    expect(windowOpacityFor(state({ intensity: 100 }))).toBe(linear(100))
    expect(windowOpacityFor(state({ intensity: 100 }))).toBeCloseTo(TRANSLUCENCY_OPACITY_FLOOR, 12)
  })

  it('is monotonic and never dips below the floor', () => {
    let previous = 1.1

    for (let lever = 0; lever <= 100; lever += 1) {
      const opacity = windowOpacityFor(state({ intensity: lever }))

      expect(opacity).toBeLessThanOrEqual(previous)
      expect(opacity).toBeGreaterThanOrEqual(TRANSLUCENCY_OPACITY_FLOOR)
      previous = opacity
    }
  })

  it('follows the documented curve rather than a straight line', () => {
    const ratio = 0.5
    const expected = 1 - (1 - TRANSLUCENCY_OPACITY_FLOOR) * Math.pow(ratio, TRANSLUCENCY_CURVE)

    expect(windowOpacityFor(state({ intensity: 50 }))).toBeCloseTo(expected, 12)
  })

  it('ignores intensity under glass — the tint is a page effect', () => {
    expect(windowOpacityFor(state({ intensity: 100, mode: 'glass' }))).toBe(1)
  })

  it('ignores fade under clear', () => {
    expect(windowOpacityFor(state({ fade: 100, intensity: 0, mode: 'clear' }))).toBe(1)
  })

  it('gates fade on glass being ACTIVE, not merely selected', () => {
    // M-01: off has to mean off. A glass window at intensity 0 with the mac
    // light default's single point of fade must sit at exactly 1.
    expect(windowOpacityFor(state({ fade: 1, intensity: 0, mode: 'glass' }))).toBe(1)
    expect(windowOpacityFor(state({ fade: 100, intensity: 1, mode: 'glass' }))).toBeCloseTo(
      TRANSLUCENCY_OPACITY_FLOOR,
      12
    )
  })
})

describe('glassActive', () => {
  it('needs both the mode and a non-zero tint', () => {
    expect(glassActive(state({ intensity: 40, mode: 'glass' }))).toBe(true)
    expect(glassActive(state({ intensity: 0, mode: 'glass' }))).toBe(false)
    expect(glassActive(state({ intensity: 40, mode: 'clear' }))).toBe(false)
  })
})

describe('glassSurfaceKeep', () => {
  it('runs linearly to zero so the slider spans opaque theme → bare glass', () => {
    expect(glassSurfaceKeep(0)).toBe(TRANSLUCENCY_MAX)
    expect(glassSurfaceKeep(35)).toBe(65)
    expect(glassSurfaceKeep(100)).toBe(0)
    expect(glassSurfaceKeep(Number.NaN)).toBe(TRANSLUCENCY_MAX)
  })
})

describe('normalizeMaterial / normalizeScope', () => {
  it('falls back for anything not on the ladder', () => {
    expect(normalizeMaterial('popover')).toBe('popover')
    expect(normalizeMaterial('sidebar')).toBe('under-window')
    expect(normalizeMaterial(undefined)).toBe('under-window')
    expect(normalizeScope('sidebar')).toBe('sidebar')
    expect(normalizeScope('elsewhere')).toBe('window')
  })
})

describe('vibrancyFor / backgroundMaterialFor', () => {
  it('rests on sidebar / none while glass is off', () => {
    expect(vibrancyFor(state({ material: 'popover', mode: 'clear' }))).toBe('sidebar')
    expect(vibrancyFor(state({ intensity: 0, material: 'popover', mode: 'glass' }))).toBe('sidebar')
    expect(backgroundMaterialFor(state({ material: 'popover', mode: 'clear' }))).toBe('none')
  })

  it('carries the chosen rung while glass is active', () => {
    const active = state({ intensity: 30, material: 'popover', mode: 'glass' })

    expect(vibrancyFor(active)).toBe('popover')
    expect(backgroundMaterialFor(active)).toBe('tabbed')
    expect(backgroundMaterialFor({ ...active, material: 'under-window' })).toBe('acrylic')
    expect(backgroundMaterialFor({ ...active, material: 'titlebar' })).toBe('mica')
    expect(backgroundMaterialFor({ ...active, material: 'header' })).toBe('mica')
  })
})

describe('glassMaterialsFor', () => {
  it('offers every rung off Windows', () => {
    expect(glassMaterialsFor(false)).toEqual([...GLASS_MATERIALS])
  })

  it('never offers two rungs that composite to the same backdrop', () => {
    // M-06: `titlebar` and `header` both land on mica.
    const offered = glassMaterialsFor(true)
    const backdrops = offered.map(rung => backgroundMaterialFor(state({ intensity: 1, material: rung, mode: 'glass' })))

    expect(new Set(backdrops).size).toBe(backdrops.length)
    expect(offered.length).toBeLessThan(GLASS_MATERIALS.length)
  })

  it('leaves every backdrop reachable from the offered list', () => {
    const reachable = new Set(
      GLASS_MATERIALS.map(rung => backgroundMaterialFor(state({ intensity: 1, material: rung, mode: 'glass' })))
    )

    const offered = new Set(
      glassMaterialsFor(true).map(rung => backgroundMaterialFor(state({ intensity: 1, material: rung, mode: 'glass' })))
    )

    expect(offered).toEqual(reachable)
  })
})

describe('glassMaterialForPicker', () => {
  it('folds a rung Windows cannot render without rewriting the saved value', () => {
    // M-07: a `header` frost saved on a Mac highlights `titlebar` on Windows
    // and the persisted value is untouched.
    expect(glassMaterialForPicker('header', true)).toBe('titlebar')
    expect(glassMaterialForPicker('header', false)).toBe('header')
    expect(glassMaterialForPicker('popover', true)).toBe('popover')
    expect(glassMaterialsFor(true)).not.toContain('header')
  })
})

describe('hudFrostFor', () => {
  it('needs both the band showing and glass active', () => {
    const active = state({ intensity: 30, material: 'popover', mode: 'glass' })

    expect(hudFrostFor(active, true)).toEqual({ backgroundMaterial: 'tabbed', vibrancy: 'popover' })
    expect(hudFrostFor(active, false)).toEqual({ backgroundMaterial: 'none', vibrancy: null })
    expect(hudFrostFor(state({ intensity: 0, mode: 'glass' }), true)).toEqual({
      backgroundMaterial: 'none',
      vibrancy: null
    })
  })

  it('answers null rather than a resting material — a transparent window has nothing to hide it behind', () => {
    expect(hudFrostFor(state({ mode: 'clear' }), true).vibrancy).toBeNull()
  })
})

describe('normalizeState', () => {
  it('survives junk and keeps the legacy clear rule', () => {
    expect(normalizeState(null, true)).toEqual({
      fade: 0,
      intensity: 0,
      material: 'under-window',
      mode: 'glass',
      scope: 'window'
    })
    expect(normalizeState({ intensity: 40 }, true).mode).toBe('clear')
    expect(normalizeState({ material: 'nope', scope: 'nope' }, false)).toEqual({
      fade: 0,
      intensity: 0,
      material: 'under-window',
      mode: 'clear',
      scope: 'window'
    })
  })
})

describe('defaults table', () => {
  it('carries the per-appearance, per-platform numbers verbatim', () => {
    expect(defaultTranslucencyValues('light', false)).toEqual({
      fade: 1,
      intensity: 66,
      material: 'header',
      scope: 'window'
    })
    expect(defaultTranslucencyValues('dark', false)).toEqual({
      fade: 0,
      intensity: 22,
      material: 'titlebar',
      scope: 'window'
    })
    expect(defaultTranslucencyValues('light', true)).toEqual({
      fade: 0,
      intensity: 20,
      material: 'under-window',
      scope: 'window'
    })
    expect(defaultTranslucencyValues('dark', true)).toEqual({
      fade: 0,
      intensity: 5,
      material: 'under-window',
      scope: 'window'
    })
  })

  it('defaultTranslucencyState adds the mode and nothing else', () => {
    expect(defaultTranslucencyState('dark', true, false)).toEqual({
      ...defaultTranslucencyValues('dark', false),
      mode: 'glass'
    })
    expect(defaultTranslucencyState('dark', false, false).mode).toBe('clear')
  })
})

describe('normalizeBook', () => {
  it('migrates a flat v1 payload into base, so BOTH appearances inherit it', () => {
    // M-03: landing migrated values in `light` would leave dark on the
    // per-appearance default, silently changing a window the user had tuned.
    const migrated = normalizeBook({ intensity: 40 }, true)

    expect(migrated).toEqual({ base: { intensity: 40 }, dark: {}, light: {}, mode: 'clear' })
    expect(resolveTranslucency(migrated, 'dark', false).intensity).toBe(40)
    expect(resolveTranslucency(migrated, 'light', false).intensity).toBe(40)
  })

  it('migrates an untouched legacy profile onto glass', () => {
    expect(normalizeBook({ intensity: 0 }, true).mode).toBe('glass')
  })

  it('reads a v2 book without migrating it', () => {
    const parsed = normalizeBook({ base: { intensity: 10 }, dark: {}, light: { intensity: 70 }, mode: 'glass' }, true)

    expect(parsed).toEqual({ base: { intensity: 10 }, dark: {}, light: { intensity: 70 }, mode: 'glass' })
  })

  it('drops unknown keys and never throws on junk', () => {
    expect(normalizeBook('nonsense', true)).toEqual({ base: {}, dark: {}, light: {}, mode: 'glass' })
    expect(normalizeBook({ base: { bogus: 1, intensity: '55' }, dark: 7, light: null, mode: 'nope' }, true)).toEqual({
      base: { intensity: 55 },
      dark: {},
      light: {},
      mode: 'glass'
    })
  })
})

describe('resolveTranslucency', () => {
  it('inherits PER KEY: appearance → base → default', () => {
    // M-04: falling back per appearance instead of per key would drop the
    // base material the moment an appearance set only its intensity.
    const resolved = resolveTranslucency(
      book({ base: { intensity: 10, material: 'popover' }, light: { intensity: 70 } }),
      'light',
      false
    )

    expect(resolved.intensity).toBe(70)
    expect(resolved.material).toBe('popover')
    expect(resolved.fade).toBe(defaultTranslucencyValues('light', false).fade)
  })

  it('carries the book-wide mode into every appearance', () => {
    const clear = book({ mode: 'clear' })

    expect(resolveTranslucency(clear, 'light', false).mode).toBe('clear')
    expect(resolveTranslucency(clear, 'dark', true).mode).toBe('clear')
  })

  it('uses the platform defaults when nothing was ever set', () => {
    expect(resolveTranslucency(book(), 'dark', true)).toEqual({
      ...defaultTranslucencyValues('dark', true),
      mode: 'glass'
    })
  })
})

describe('setTranslucencyValues', () => {
  it('writes only the painted appearance', () => {
    // M-05: writing into `base` would move dark while tuning light.
    const next = setTranslucencyValues(book({ base: { intensity: 10 } }), 'light', { intensity: 80 })

    expect(next.light).toEqual({ intensity: 80 })
    expect(next.dark).toEqual({})
    expect(next.base).toEqual({ intensity: 10 })
    expect(resolveTranslucency(next, 'dark', false).intensity).toBe(10)
  })

  it('normalises the patch and ignores keys it does not own', () => {
    const next = setTranslucencyValues(book(), 'dark', {
      intensity: 140,
      material: 'nope'
    } as unknown as Partial<TranslucencyState>)

    expect(next.dark).toEqual({ intensity: 100, material: 'under-window' })
    expect(next.mode).toBe('glass')
  })
})

// The transparent-window flag has to be declared in every platform config that
// Tauri merges, and the merge is RFC 7386 — `app.windows` is an ARRAY, so a
// platform file REPLACES it wholesale rather than patching element 0. That
// makes the duplicated window object a live drift trap: a later `minWidth`
// change applied to one file only ships two different windows (M-19).
describe('platform window config', () => {
  const readWindow = (file: string): Record<string, unknown> => {
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../src-tauri')

    const parsed = JSON.parse(readFileSync(path.join(root, file), 'utf8')) as {
      app: { windows: Record<string, unknown>[] }
    }

    expect(parsed.app.windows).toHaveLength(1)

    return parsed.app.windows[0]
  }

  it('describes the same main window everywhere except `transparent`', () => {
    const shared = readWindow('tauri.conf.json')
    const macos = readWindow('tauri.macos.conf.json')
    const windows = readWindow('tauri.windows.conf.json')

    expect(shared.transparent).toBeUndefined()
    expect(macos.transparent).toBe(true)
    expect(windows.transparent).toBe(true)

    const { transparent: _mac, ...macRest } = macos
    const { transparent: _win, ...winRest } = windows

    expect(macRest).toEqual(shared)
    expect(winRest).toEqual(shared)
  })
})
