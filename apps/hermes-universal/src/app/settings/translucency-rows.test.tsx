/**
 * The Appearance page's translucency rows.
 *
 * The gate is the CAPABILITY report, never `IS_DESKTOP`: Linux does Clear and
 * not Glass, an old Windows 11 does neither, and a phone gets no row at all
 * rather than a control the platform cannot honour.
 */

import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import type { AppearanceCapabilities } from '@/store/translucency'
import {
  $glassCapabilities,
  $translucency,
  $translucencyBook,
  $translucencyPeek,
  resetTranslucencyPeek,
  setGlassAppearance
} from '@/store/translucency'

import { TranslucencySettings } from './translucency-rows'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined) }))

const caps = (patch: Partial<AppearanceCapabilities> = {}): AppearanceCapabilities => ({
  glass: 'supported',
  materials: ['under-window', 'popover', 'titlebar', 'header'],
  notes: [],
  osBuild: null,
  platform: 'macos',
  translucency: 'supported',
  ...patch
})

const draw = () =>
  render(
    <I18nProvider>
      <TranslucencySettings />
    </I18nProvider>
  )

const rowCount = (): number => document.querySelectorAll('[id^="setting-row-appearance."]').length

beforeEach(() => {
  resetTranslucencyPeek()
  setGlassAppearance('dark')
  $glassCapabilities.set(caps())
  $translucencyBook.set({ base: { intensity: 40 }, dark: {}, light: {}, mode: 'glass' })
})

describe('gating', () => {
  it('renders nothing at all before the platform has answered', () => {
    $glassCapabilities.set(null)
    draw()

    expect(rowCount()).toBe(0)
  })

  it('renders nothing where translucency is unsupported (a phone)', () => {
    $glassCapabilities.set(
      caps({ glass: 'unsupported', materials: [], platform: 'android', translucency: 'unsupported' })
    )
    draw()

    expect(rowCount()).toBe(0)
  })

  it('renders all five rows where glass works', () => {
    draw()

    expect(rowCount()).toBe(5)
    expect(document.querySelector('#setting-row-appearance\\.frost')).not.toBeNull()
  })

  it('drops the glass rows on a platform with no material, and says why', () => {
    $glassCapabilities.set(caps({ glass: 'unsupported', materials: [], platform: 'linux' }))
    $translucencyBook.set({ base: { intensity: 40 }, dark: {}, light: {}, mode: 'clear' })
    draw()

    expect(rowCount()).toBe(2)
    expect(document.querySelector('#setting-row-appearance\\.frost')).toBeNull()
    expect(screen.getByText(/window material this desktop does not provide/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Glass' })).toBeNull()
  })

  it('names the build on a Windows below the floor', () => {
    $glassCapabilities.set(caps({ glass: 'unsupported', materials: [], osBuild: 19045, platform: 'windows' }))
    $translucencyBook.set({ base: { intensity: 40 }, dark: {}, light: {}, mode: 'clear' })
    draw()

    expect(screen.getByText(/this system reports 19045/i)).toBeTruthy()
  })

  it('collapses to one row when the tint is zero — off is off', () => {
    $translucencyBook.set({ base: { intensity: 0 }, dark: {}, light: {}, mode: 'glass' })
    draw()

    expect(rowCount()).toBe(1)
  })
})

describe('editing', () => {
  it('writes only the material when a frost rung is clicked', () => {
    draw()

    const before = $translucency.get()

    fireEvent.click(screen.getByRole('button', { name: 'Soft' }))

    expect($translucency.get()).toEqual({ ...before, material: 'popover' })
  })

  it('remembers the tint across an off/on round trip', () => {
    draw()

    fireEvent.click(screen.getByRole('button', { name: 'Off' }))

    expect($translucency.get().intensity).toBe(0)

    fireEvent.click(screen.getByRole('button', { name: 'Glass' }))

    expect($translucency.get().intensity).toBe(40)
  })

  it('ghosts the overlay while a slider is held, and lets go on release', () => {
    draw()

    const slider = screen.getByLabelText('Tint')

    fireEvent.pointerDown(slider)

    expect($translucencyPeek.get()).toBe(true)

    fireEvent.pointerUp(slider)

    expect($translucencyPeek.get()).toBe(false)
  })

  it('resets a stuck hold when the surface unmounts', () => {
    const view = draw()

    fireEvent.pointerDown(screen.getByLabelText('Tint'))

    expect($translucencyPeek.get()).toBe(true)

    // A pointer held when Escape closes the overlay never delivers its
    // `pointerup`, and a stuck counter would ghost the NEXT overlay too.
    view.unmount()

    expect($translucencyPeek.get()).toBe(false)
  })
})
