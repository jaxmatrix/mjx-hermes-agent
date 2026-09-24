/**
 * Keep-awake on the Advanced page: a device-local machine preference with no
 * config key, so it rides above the schema fields rather than among them.
 */

import { QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Type-only, so it is erased and cannot trip vi.mock's hoisting.
import type * as PlatformModule from '@/lib/platform'

vi.mock('@/hermes', () => ({
  profileScopeKey: (profile?: string | null) => (profile ?? '').trim() || 'default',
  peekConfigReadOrigin: () => undefined,
  retainConfigReadOrigin: (record: object) => record,
  getProfiles: vi.fn(async () => ({ profiles: [] })),
  getApiRequestConnection: () => null,
  getApiRequestProfile: () => 'default',
  setApiRequestProfile: vi.fn(),
  getHermesConfigRecord: vi.fn(async () => ({})),
  // One real Advanced key so the loaded body has a field of its own to wait for.
  getHermesConfigSchema: vi.fn(async () => ({ fields: { 'terminal.docker_image': { type: 'string' } } })),
  saveHermesConfig: vi.fn(async () => ({ ok: true }))
}))

// Rust answers with the inhibitor it actually holds, so the row has to follow
// that answer rather than the ask — mocked here at the same IPC boundary the
// power bridge uses. The store mirrors prefs through window.hermesDesktop, not
// invoke directly.
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn(async (_cmd: string, args: { on: boolean }) => args.on) }))

vi.mock('@tauri-apps/api/core', () => ({ invoke }))

const { desktop } = vi.hoisted(() => ({ desktop: { value: true } }))

vi.mock('@/lib/platform', async importActual => ({
  ...(await importActual<typeof PlatformModule>()),
  get IS_DESKTOP() {
    return desktop.value
  }
}))

import { I18nProvider } from '@/i18n'
import { powerBridge } from '@/lib/hermes-desktop/power'
import { queryClient } from '@/lib/query-client'
import { $keepAwake } from '@/store/keep-awake'
import { $profiles } from '@/store/profile'

import { SectionBody } from './settings-section'

const desktopWindow = window as unknown as { hermesDesktop?: Window['hermesDesktop'] }
const initialHermesDesktop = desktopWindow.hermesDesktop

const renderAdvanced = () =>
  render(
    <MemoryRouter>
      <I18nProvider>
        <QueryClientProvider client={queryClient}>
          <SectionBody section="advanced" />
        </QueryClientProvider>
      </I18nProvider>
    </MemoryRouter>
  )

beforeEach(() => {
  desktop.value = true
  invoke.mockReset()
  invoke.mockImplementation(async (_cmd: string, args: { on: boolean }) => args.on)
  desktopWindow.hermesDesktop = {
    ...desktopWindow.hermesDesktop,
    setKeepAwake: powerBridge.setKeepAwake
  } as Window['hermesDesktop']
  $keepAwake.set(false)
  $profiles.set([])
  queryClient.clear()
})

afterEach(() => {
  $keepAwake.set(false)
  desktopWindow.hermesDesktop = initialHermesDesktop
  queryClient.clear()
})

describe('Advanced → keep computer awake', () => {
  it('flips the preference from the row', async () => {
    renderAdvanced()

    // Wait for the schema body so KeepAwakeRow settles in its final mount
    // (headerSlot remounts once ConfigSection leaves the skeleton branch).
    await screen.findByRole('textbox')
    const toggle = screen.getByRole('switch', { name: 'Keep computer awake' })
    expect(toggle).toBeInTheDocument()

    fireEvent.click(toggle)
    expect($keepAwake.get()).toBe(true)

    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('set_keep_awake', { on: true }))
    expect(screen.getByRole('switch', { name: 'Keep computer awake' })).toBeChecked()
  })

  // There is no logind under WSL or on a non-systemd distro: the ask really is
  // refused in the wild, and a switch left sitting "on" over a machine free to
  // sleep is the one outcome this row must never produce.
  it('snaps back off when the OS refuses the inhibitor', async () => {
    invoke.mockRejectedValueOnce(new Error('no logind'))
    renderAdvanced()

    await screen.findByRole('textbox')
    fireEvent.click(screen.getByRole('switch', { name: 'Keep computer awake' }))
    await vi.waitFor(() => {
      expect(screen.getByRole('switch', { name: 'Keep computer awake' })).not.toBeChecked()
    })
    expect($keepAwake.get()).toBe(false)
  })

  it('is absent off desktop', async () => {
    desktop.value = false
    renderAdvanced()

    // The page still renders — wait for its schema field before asserting the
    // row is missing.
    await screen.findByRole('textbox')
    expect(screen.queryByRole('switch', { name: 'Keep computer awake' })).not.toBeInTheDocument()
  })
})
