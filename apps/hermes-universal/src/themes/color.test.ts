/**
 * The OKLCH layer.
 *
 * These helpers exist because the sRGB/HSL versions LIE in specific, shipped
 * ways — a hue sweep that turns to mud, a blue that blends lavender, a brand
 * colour that washes out when it's lightened to pass contrast. Every case below
 * seeds the value that the naive implementation gets wrong, so the test can
 * only pass if the perceptual math is actually running.
 */

import { describe, expect, it } from 'vitest'

import {
  contrastRatio,
  ensureContrast,
  ensureContrastOklch,
  harmonize,
  hexToOklch,
  hueDelta,
  maxChroma,
  mix,
  mixOklab,
  oklchToHex,
  oklchToSrgb255,
  readableOn,
  withHue
} from './color'

const NOUS_BLUE = '#0053FD'

describe('hexToOklch', () => {
  it('round-trips an in-gamut colour through oklchToHex', () => {
    for (const hex of ['#0053fd', '#4f9e5e', '#cf222e', '#e6edf3', '#1f2328']) {
      expect(oklchToHex(hexToOklch(hex)!).toLowerCase()).toBe(hex.toLowerCase())
    }
  })

  it('rejects what is not a 6-digit hex', () => {
    expect(hexToOklch('#00')).toBeNull()
    expect(hexToOklch('nonsense')).toBeNull()
  })

  it('reads greys as (near) zero chroma at full lightness range', () => {
    expect(hexToOklch('#808080')!.c).toBeLessThan(0.01)
    expect(hexToOklch('#ffffff')!.l).toBeCloseTo(1, 2)
    expect(hexToOklch('#000000')!.l).toBeCloseTo(0, 2)
  })
})

describe('oklchToHex', () => {
  // The failure this guards: clipping the sRGB channels instead of reducing
  // chroma shifts the HUE — a saturated blue clips to a different blue.
  it('gives up chroma, not hue or lightness, when a colour is out of gamut', () => {
    const wanted = { l: 0.55, c: 0.36, h: 264 }
    const got = hexToOklch(oklchToHex(wanted))!

    expect(got.c).toBeLessThan(wanted.c)
    expect(Math.abs(hueDelta(wanted.h, got.h))).toBeLessThan(1)
    expect(Math.abs(got.l - wanted.l)).toBeLessThan(0.01)
  })

  it('leaves an in-gamut colour alone', () => {
    const wanted = hexToOklch('#4f9e5e')!

    expect(hexToOklch(oklchToHex(wanted))!.c).toBeCloseTo(wanted.c, 3)
  })
})

describe('oklchToSrgb255', () => {
  it('returns null outside the display gamut rather than clamping silently', () => {
    expect(oklchToSrgb255({ l: 0.55, c: 0.36, h: 264 })).toBeNull()
  })

  it('agrees with oklchToHex where the colour is real', () => {
    const lch = hexToOklch(NOUS_BLUE)!
    const [r, g, b] = oklchToSrgb255(lch)!

    expect([r, g, b]).toEqual([0x00, 0x53, 0xfd])
  })
})

describe('maxChroma', () => {
  it('lands on the gamut boundary — in at the value, out just past it', () => {
    for (const h of [30, 150, 264]) {
      const c = maxChroma(0.6, h)

      expect(oklchToSrgb255({ l: 0.6, c, h }), `in at ${h}°`).not.toBeNull()
      expect(oklchToSrgb255({ l: 0.6, c: c + 0.01, h }), `out past ${h}°`).toBeNull()
    }
  })

  // The wedge is not a rectangle: at the same lightness, sRGB has far more room
  // for a yellow-green than for a blue. A picker that drew a rectangle would
  // clamp a third of its area to the same few hexes.
  it('depends on hue, not just lightness', () => {
    expect(maxChroma(0.9, 110)).toBeGreaterThan(maxChroma(0.9, 264) * 2)
  })
})

describe('hueDelta', () => {
  // Hue is a circle. The subtraction version returns -340 here and sends a
  // green the long way round the wheel.
  it('takes the short way round', () => {
    expect(hueDelta(350, 10)).toBe(20)
    expect(hueDelta(10, 350)).toBe(-20)
  })

  it('is signed, and zero on itself', () => {
    expect(hueDelta(100, 130)).toBe(30)
    expect(hueDelta(130, 100)).toBe(-30)
    expect(hueDelta(264, 264)).toBe(0)
  })
})

describe('harmonize', () => {
  const EMERALD = '#10b981'

  it('bends a semantic colour PART of the way, never onto the accent', () => {
    const emerald = hexToOklch(EMERALD)!.h
    const accent = hexToOklch(NOUS_BLUE)!.h
    const bent = hexToOklch(harmonize(EMERALD, NOUS_BLUE, 0.25))!.h

    // Moved toward the accent…
    expect(Math.abs(hueDelta(emerald, bent))).toBeGreaterThan(5)
    // …but nowhere near it, or "done" and "running" become one colour.
    expect(Math.abs(hueDelta(bent, accent))).toBeGreaterThan(30)
  })

  // Strength drives the HUE only. Chroma is separately floored at 85% of the
  // accent's so a bent colour never reads duller than the palette around it —
  // which is why strength 0 is not a byte-identity.
  it('holds the hue at strength 0 and lands on the accent hue at 1', () => {
    expect(Math.abs(hueDelta(hexToOklch(harmonize(EMERALD, NOUS_BLUE, 0))!.h, hexToOklch(EMERALD)!.h))).toBeLessThan(1)
    expect(Math.abs(hueDelta(hexToOklch(harmonize(EMERALD, NOUS_BLUE, 1))!.h, hexToOklch(NOUS_BLUE)!.h))).toBeLessThan(
      1
    )
  })

  it('costs nothing when the accent is already the same family', () => {
    // GitHub's green accent (148°) against emerald (162°): a 14° arc, so a 0.25
    // rotation moves it ~3.5° — invisible, which is the point.
    expect(Math.abs(hueDelta(hexToOklch(harmonize(EMERALD, '#196d31', 0.25))!.h, hexToOklch(EMERALD)!.h))).toBeLessThan(
      6
    )
  })

  it('returns the input unchanged when either colour is unparseable', () => {
    expect(harmonize(EMERALD, 'nonsense', 0.25)).toBe(EMERALD)
    expect(harmonize('nonsense', NOUS_BLUE, 0.25)).toBe('nonsense')
  })
})

describe('mixOklab', () => {
  // The shipped bug: `mix` lerps gamma-encoded sRGB, which drags a saturated
  // blue several degrees violet on the way to white — a clean blue accent
  // produced a LAVENDER selection row.
  it('holds the hue where sRGB mixing drifts it', () => {
    const seedHue = hexToOklch(NOUS_BLUE)!.h
    const oklab = Math.abs(hueDelta(seedHue, hexToOklch(mixOklab(NOUS_BLUE, '#ffffff', 0.88))!.h))
    const srgb = Math.abs(hueDelta(seedHue, hexToOklch(mix(NOUS_BLUE, '#ffffff', 0.88))!.h))

    expect(srgb).toBeGreaterThan(2)
    expect(oklab).toBeLessThan(0.5)
  })

  it('is the endpoints at 0 and 1, and clamps beyond them', () => {
    expect(mixOklab(NOUS_BLUE, '#ffffff', 0).toLowerCase()).toBe(NOUS_BLUE.toLowerCase())
    expect(mixOklab(NOUS_BLUE, '#ffffff', 1).toLowerCase()).toBe('#ffffff')
    expect(mixOklab(NOUS_BLUE, '#ffffff', 2).toLowerCase()).toBe('#ffffff')
  })

  it('returns the first colour when either side is unparseable', () => {
    expect(mixOklab(NOUS_BLUE, 'nonsense', 0.5)).toBe(NOUS_BLUE)
  })
})

describe('withHue', () => {
  // HSL's version of this gives mud at 60° and a washed teal at 200° because
  // HSL "lightness" is not lightness. Every hue must land at the same weight.
  it('holds perceived lightness across a full hue sweep', () => {
    const base = hexToOklch(NOUS_BLUE)!

    for (let h = 0; h < 360; h += 30) {
      expect(Math.abs(hexToOklch(withHue(NOUS_BLUE, h))!.l - base.l), `L at ${h}°`).toBeLessThan(0.02)
    }
  })

  it('only ever reduces chroma, and only where sRGB cannot show it', () => {
    const base = hexToOklch(NOUS_BLUE)!

    for (let h = 0; h < 360; h += 30) {
      expect(hexToOklch(withHue(NOUS_BLUE, h))!.c, `C at ${h}°`).toBeLessThanOrEqual(base.c + 0.005)
    }
  })

  it('normalises out-of-range hues', () => {
    expect(withHue(NOUS_BLUE, 380)).toBe(withHue(NOUS_BLUE, 20))
    expect(withHue(NOUS_BLUE, -20)).toBe(withHue(NOUS_BLUE, 340))
  })

  it('leaves an unparseable colour alone', () => {
    expect(withHue('nonsense', 120)).toBe('nonsense')
  })
})

describe('ensureContrastOklch', () => {
  const DARK_SIDEBAR = '#010409'

  it('lifts a colour that fails onto the AA line', () => {
    expect(contrastRatio(NOUS_BLUE, DARK_SIDEBAR)).toBeLessThan(4.5)
    expect(contrastRatio(ensureContrastOklch(NOUS_BLUE, DARK_SIDEBAR, 4.5), DARK_SIDEBAR)).toBeGreaterThanOrEqual(4.5)
  })

  // The whole reason this exists next to `ensureContrast`: mixing toward white
  // passes contrast by throwing the brand colour away.
  it('keeps far more of the colourfulness than mixing toward white does', () => {
    const seed = hexToOklch(NOUS_BLUE)!
    const walked = hexToOklch(ensureContrastOklch(NOUS_BLUE, DARK_SIDEBAR, 4.5))!
    const mixed = hexToOklch(ensureContrast(NOUS_BLUE, DARK_SIDEBAR, 4.5))!

    expect(walked.c).toBeGreaterThan(mixed.c)
    expect(Math.abs(hueDelta(seed.h, walked.h))).toBeLessThan(Math.abs(hueDelta(seed.h, mixed.h)) + 0.001)
  })

  it('darkens instead on a light backdrop', () => {
    const lifted = ensureContrastOklch('#8fd6a4', '#ffffff', 4.5)

    expect(hexToOklch(lifted)!.l).toBeLessThan(hexToOklch('#8fd6a4')!.l)
    expect(contrastRatio(lifted, '#ffffff')).toBeGreaterThanOrEqual(4.5)
  })

  it('returns the colour untouched when it already passes', () => {
    expect(ensureContrastOklch('#ffffff', DARK_SIDEBAR, 4.5)).toBe('#ffffff')
  })
})

describe('readableOn', () => {
  // The luminance-threshold version got exactly these wrong, in the direction
  // that ships unreadable text: it answered white for both.
  it.each([
    ['#4f9e5e', '#161616'], // GitHub dark green — white is 3.29:1, near-black 5.50:1
    ['#cba6f7', '#161616'] // Catppuccin mauve — white is 2.03:1
  ])('picks the foreground that actually measures better on %s', (bg, expected) => {
    expect(readableOn(bg)).toBe(expected)
    expect(contrastRatio(bg, expected)).toBeGreaterThan(
      contrastRatio(bg, expected === '#ffffff' ? '#161616' : '#ffffff')
    )
  })

  it('still answers white on a genuinely dark surface', () => {
    expect(readableOn('#0d1117')).toBe('#ffffff')
  })
})
