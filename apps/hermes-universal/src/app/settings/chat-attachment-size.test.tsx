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
import { flushSync } from 'react-dom'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/hermes', () => ({
  profileScopeKey: (profile?: string | null) => (profile ?? '').trim() || 'default',
  peekConfigReadOrigin: () => undefined,
  retainConfigReadOrigin: (record: object) => record,
  getProfiles: vi.fn(async () => ({ profiles: [] })),
  getApiRequestConnection: () => null,
  getApiRequestProfile: () => 'default',
  setApiRequestProfile: vi.fn(),
  getHermesConfigRecord: vi.fn(async () => ({ display: { show_reasoning: false }, timezone: 'UTC' })),
  getHermesConfigSchema: vi.fn(async () => ({
    fields: {
      'display.show_reasoning': { type: 'boolean' },
      timezone: { type: 'string' }
    }
  })),
  saveHermesConfig: vi.fn(async () => ({ ok: true }))
}))

const dataUrlSet = vi.hoisted(() => vi.fn())

const desktopWindow = window as unknown as { hermesDesktop?: Window['hermesDesktop'] }
const initialHermesDesktop = desktopWindow.hermesDesktop

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

const field = async () => {
  // ConfigSection remounts headerSlot once schema/config arrive — wait for a
  // schema field so AttachmentSizeRow is on its final mount before we edit.
  await screen.findByRole('switch')

  return screen.getByRole('spinbutton', { name: 'Max preview / image load size in megabytes' })
}

/** React 18 batches the change — blur must run after the draft updates. */
async function editCap(input: HTMLElement, value: string) {
  flushSync(() => {
    fireEvent.change(input, { target: { value } })
  })

  if (value === '') {
    expect(input).toHaveValue(null)
  } else {
    expect(input).toHaveValue(Number(value))
  }

  fireEvent.blur(input)
}

beforeEach(() => {
  dataUrlSet.mockReset()
  dataUrlSet.mockImplementation(async (maxMb: number) => ({
    defaultMaxMb: DATA_URL_READ_DEFAULT_MAX_MB,
    maxBytes: maxMb * 1024 * 1024,
    maxMb
  }))
  desktopWindow.hermesDesktop = {
    dataUrlReadMax: {
      get: vi.fn(async () => ({
        defaultMaxMb: DATA_URL_READ_DEFAULT_MAX_MB,
        maxBytes: 24 * 1024 * 1024,
        maxMb: 24
      })),
      set: dataUrlSet
    }
  } as unknown as Window['hermesDesktop']
  // Seed AWAY from the default so a row that ignores the store and renders 16
  // fails instead of accidentally matching.
  $dataUrlReadMaxMb.set(24)
  queryClient.clear()
})

afterEach(() => {
  desktopWindow.hermesDesktop = initialHermesDesktop
  $dataUrlReadMaxMb.set(DATA_URL_READ_DEFAULT_MAX_MB)
  queryClient.clear()
})

describe('Chat → max attachment / preview size', () => {
  it('shows the stored cap and pushes an edit down to Rust', async () => {
    renderChat()

    const input = await field()
    expect(input).toHaveValue(24)

    await editCap(input, '32')

    await vi.waitFor(() => expect($dataUrlReadMaxMb.get()).toBe(32))
    expect(dataUrlSet).toHaveBeenCalledWith(32)
  })

  it('clamps a value past the ceiling instead of accepting it', async () => {
    renderChat()

    const input = await field()
    await editCap(input, '99999')

    await vi.waitFor(() => expect($dataUrlReadMaxMb.get()).toBe(4096))
    await vi.waitFor(() => expect(input).toHaveValue(4096))
  })

  // `Number('')` is 0, which the clamp reads as the 1 MB floor — i.e. every
  // attach refused. Clearing the field has to mean "back to the default".
  it('reads an emptied field as the default, not the floor', async () => {
    renderChat()

    const input = await field()
    await editCap(input, '')

    await vi.waitFor(() => expect($dataUrlReadMaxMb.get()).toBe(16))
  })

  // The disagreeing case: Rust is free to store something else, and the row must
  // end up showing THAT. Otherwise Settings promises a cap the refusal message
  // and the reader do not use.
  it('follows the cap Rust reports back when it differs from the ask', async () => {
    dataUrlSet.mockImplementationOnce(async () => ({
      defaultMaxMb: DATA_URL_READ_DEFAULT_MAX_MB,
      maxBytes: 64 * 1024 * 1024,
      maxMb: 64
    }))
    renderChat()

    const input = await field()
    await editCap(input, '32')

    await vi.waitFor(() => expect(input).toHaveValue(64))
    expect($dataUrlReadMaxMb.get()).toBe(64)
  })
})
