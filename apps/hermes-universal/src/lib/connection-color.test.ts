/**
 * MJXHRM-591 — a tab bound to a background connection is told apart by COLOUR,
 * not by a text chip: the hue is deterministic, so it needs no storage, no
 * registry field and no translation.
 */

import { describe, expect, it } from 'vitest'

import { connectionColor, connectionColorSoft } from '@/lib/connection-color'

describe('connectionColor', () => {
  it('leaves the local connection neutral', () => {
    expect(connectionColor('local')).toBeNull()
    expect(connectionColor(null)).toBeNull()
    expect(connectionColor(undefined)).toBeNull()
    expect(connectionColor('  ')).toBeNull()
  })

  it('is stable for one id and different between ids', () => {
    const a = connectionColor('conn-a')

    expect(a).toBe(connectionColor('conn-a'))
    expect(a).toMatch(/^hsl\(\d+ 68% 58%\)$/)
    expect(a).not.toBe(connectionColor('conn-b'))
  })

  it('mixes a translucent fill for a bar or a dot halo', () => {
    expect(connectionColorSoft('hsl(10 68% 58%)', 22)).toBe('color-mix(in srgb, hsl(10 68% 58%) 22%, transparent)')
  })
})
