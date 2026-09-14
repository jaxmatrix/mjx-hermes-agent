/**
 * The attachment-size cap on the Chat page: a device-local preference with no
 * config key, so it rides above the schema fields rather than among them.
 *
 * What it guards is a Rust-side number. The row's whole job is to keep the two
 * ends agreeing — anything it shows that Rust did not accept is a cap the user
 * believes in and the app does not enforce.
 */

import { QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/hermes', () => ({
  setApiRequestProfile: vi.fn(),
  getHermesConfigRecord: vi.fn(async () => ({})),
  getHermesConfigSchema: vi.fn(async () => ({ fields: {} })),
  saveHermesConfig: vi.fn(async () => ({ ok: true }))
}))

// Rust re-clamps and answers with what it stored, so the row has to follow that
// answer rather than the keystrokes — mocked at the same IPC boundary the store
// test uses.
const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn(async (_cmd: string, args: { maxMb: number }) => args.maxMb)
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import { I18nProvider } from '@/i18n'
import { queryClient } from '@/lib/query-client'
import { $dataUrlReadMaxMb, DATA_URL_READ_DEFAULT_MAX_MB } from '@/store/data-url-read-max'

import { SectionBody } from './settings-section'

const renderChat = () =>
  render(
    <MemoryRouter>
      <I18nProvider>
        <QueryClientProvider client={queryClient}>
          <SectionBody section="chat" />
        </QueryClientProvider>
      </I18nProvider>
    </MemoryRouter>
  )

const field = () => screen.findByRole('spinbutton', { name: 'Max attachment / preview size in megabytes' })

beforeEach(() => {
  invoke.mockReset()
  invoke.mockImplementation(async (_cmd: string, args: { maxMb: number }) => args.maxMb)
  // Seed AWAY from the default so a row that ignores the store and renders 16
  // fails instead of accidentally matching.
  $dataUrlReadMaxMb.set(24)
  queryClient.clear()
})

afterEach(() => {
  $dataUrlReadMaxMb.set(DATA_URL_READ_DEFAULT_MAX_MB)
  queryClient.clear()
})

describe('Chat → max attachment / preview size', () => {
  it('shows the stored cap and pushes an edit down to Rust', async () => {
    renderChat()

    const input = await field()
    expect(input).toHaveValue(24)

    fireEvent.change(input, { target: { value: '32' } })
    fireEvent.blur(input)

    expect($dataUrlReadMaxMb.get()).toBe(32)
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('set_data_url_read_max', { maxMb: 32 }))
  })

  it('clamps a value past the ceiling instead of accepting it', async () => {
    renderChat()

    const input = await field()
    fireEvent.change(input, { target: { value: '99999' } })
    fireEvent.blur(input)

    expect($dataUrlReadMaxMb.get()).toBe(4096)
    expect(input).toHaveValue(4096)
  })

  // `Number('')` is 0, which the clamp reads as the 1 MB floor — i.e. every
  // attach refused. Clearing the field has to mean "back to the default".
  it('reads an emptied field as the default, not the floor', async () => {
    renderChat()

    const input = await field()
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.blur(input)

    expect($dataUrlReadMaxMb.get()).toBe(16)
  })

  // The disagreeing case: Rust is free to store something else, and the row must
  // end up showing THAT. Otherwise Settings promises a cap the refusal message
  // and the reader do not use.
  it('follows the cap Rust reports back when it differs from the ask', async () => {
    invoke.mockResolvedValueOnce(64)
    renderChat()

    const input = await field()
    fireEvent.change(input, { target: { value: '32' } })
    fireEvent.blur(input)

    await vi.waitFor(() => expect(input).toHaveValue(64))
    expect($dataUrlReadMaxMb.get()).toBe(64)
  })
})
