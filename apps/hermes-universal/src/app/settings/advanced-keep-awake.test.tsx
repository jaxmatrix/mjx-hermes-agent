/**
 * Keep-awake on the Advanced page: a device-local machine preference with no
 * config key, so it rides above the schema fields rather than among them.
 */

import { QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Type-only, so it is erased and cannot trip vi.mock's hoisting.
import type * as PlatformModule from '@/lib/platform'

vi.mock('@/hermes', () => ({
  setApiRequestProfile: vi.fn(),
  getHermesConfigRecord: vi.fn(async () => ({})),
  // One real Advanced key, so the loaded body has a field of its own to wait
  // for. An empty schema no longer means an empty section: FALLBACK_FIELD_SCHEMA
  // (MJXHRM-443) renders the keys the backend never declares.
  getHermesConfigSchema: vi.fn(async () => ({ fields: { 'terminal.docker_image': { type: 'string' } } })),
  saveHermesConfig: vi.fn(async () => ({ ok: true }))
}))

// Rust answers with the inhibitor it actually holds, so the row has to follow
// that answer rather than the ask — mocked here at the same IPC boundary the
// store test uses.
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
import { queryClient } from '@/lib/query-client'
import { $keepAwake } from '@/store/keep-awake'

import { SectionBody } from './settings-section'

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
  $keepAwake.set(false)
  queryClient.clear()
})

afterEach(() => {
  $keepAwake.set(false)
  queryClient.clear()
})

describe('Advanced → keep computer awake', () => {
  it('flips the preference from the row', async () => {
    renderAdvanced()

    const toggle = await screen.findByRole('switch', { name: 'Keep computer awake' })
    expect(toggle).toBeInTheDocument()

    fireEvent.click(toggle)
    expect($keepAwake.get()).toBe(true)

    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('set_keep_awake', { on: true }))
    expect(toggle).toBeChecked()
  })

  // There is no logind under WSL or on a non-systemd distro: the ask really is
  // refused in the wild, and a switch left sitting "on" over a machine free to
  // sleep is the one outcome this row must never produce.
  it('snaps back off when the OS refuses the inhibitor', async () => {
    invoke.mockRejectedValueOnce(new Error('no logind'))
    renderAdvanced()

    const toggle = await screen.findByRole('switch', { name: 'Keep computer awake' })

    fireEvent.click(toggle)
    await vi.waitFor(() => expect(toggle).not.toBeChecked())
    expect($keepAwake.get()).toBe(false)
  })

  it('is absent off desktop', async () => {
    desktop.value = false
    renderAdvanced()

    // The page still renders — wait for its schema field before asserting the
    // row is missing. NOT the empty state: since MJXHRM-443 added
    // FALLBACK_FIELD_SCHEMA, Advanced renders `timeouts.tools.sequential_call`
    // even against an empty schema, so "Nothing to configure" never appears —
    // and `findByPlaceholderText('Not set')` is ambiguous here too, since that
    // fallback field's placeholder collides with `terminal.docker_image`'s.
    await screen.findByRole('textbox')
    expect(screen.queryByRole('switch', { name: 'Keep computer awake' })).not.toBeInTheDocument()
  })
})
