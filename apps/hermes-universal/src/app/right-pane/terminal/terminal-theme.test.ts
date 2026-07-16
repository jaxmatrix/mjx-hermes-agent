import { describe, expect, it } from 'vitest'

import { terminalTheme } from './terminal-theme'

// terminalTheme is pure (withSurface/resolveSurfaceColor touch the DOM and are
// covered by the tauri-dev visual check). This pins the "always a full, readable
// table" contract that the fix depends on.
describe('terminalTheme', () => {
  it('returns the complete dark default table when no skin palette is given', () => {
    const theme = terminalTheme('dark')
    expect(theme.foreground).toBe('#cccccc')
    expect(theme.green).toBe('#0dbc79')
    expect(theme.brightWhite).toBe('#e5e5e5')
    expect(theme.selectionBackground).toBe('#264f7866')
  })

  it('returns the complete light default table when no skin palette is given', () => {
    const theme = terminalTheme('light')
    expect(theme.foreground).toBe('#333333')
    expect(theme.yellow).toBe('#949800') // mustard, legible on white
    expect(theme.selectionBackground).toBe('#add6ff80')
  })

  it('overlays only truthy palette slots, keeping the mode default for the rest', () => {
    const theme = terminalTheme('dark', { red: '#ff0000', green: undefined })
    expect(theme.red).toBe('#ff0000') // overridden
    expect(theme.green).toBe('#0dbc79') // undefined slot → keeps default
    expect(theme.foreground).toBe('#cccccc') // untouched default
  })
})
