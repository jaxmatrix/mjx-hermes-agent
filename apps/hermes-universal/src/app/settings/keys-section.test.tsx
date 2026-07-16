import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { EnvVarInfo } from '@/types/hermes'

const envVar = (over: Partial<EnvVarInfo>): EnvVarInfo => ({
  advanced: false,
  category: 'tool',
  description: '',
  is_password: true,
  is_set: false,
  redacted_value: null,
  tools: [],
  url: null,
  ...over
})

vi.mock('@/hermes', () => ({
  getEnvVars: vi.fn(async () => ({
    TAVILY_API_KEY: envVar({ category: 'tool', description: 'Tavily search' }),
    GATEWAY_PROXY: envVar({ category: 'setting', is_password: false }),
    // Provider LLM keys live on the Providers page — excluded from Tools & Keys.
    OPENAI_API_KEY: envVar({ category: 'provider', provider_label: 'OpenAI' })
  })),
  setEnvVar: vi.fn(async () => ({ ok: true })),
  revealEnvVar: vi.fn(async (key: string) => ({ key, value: 'super-secret' })),
  deleteEnvVar: vi.fn(async () => ({ ok: true }))
}))

import { setEnvVar } from '@/hermes'
import { I18nProvider } from '@/i18n'

import { KeysSection, type KeysView } from './keys-section'

const setVar = vi.mocked(setEnvVar)

const renderSection = (view: KeysView) =>
  render(
    <I18nProvider>
      <KeysSection view={view} />
    </I18nProvider>
  )

describe('KeysSection (Tools & Keys)', () => {
  beforeEach(() => setVar.mockClear())
  afterEach(() => localStorage.clear())

  it('Tools view shows tool credentials and hides settings + provider keys', async () => {
    renderSection('tools')
    expect(await screen.findByText(/tavily/i)).toBeInTheDocument()
    expect(screen.queryByText(/gateway proxy/i)).not.toBeInTheDocument() // Settings view
    expect(screen.queryByText(/openai/i)).not.toBeInTheDocument() // Providers page
  })

  it('Settings view shows setting credentials and hides tool keys', async () => {
    renderSection('settings')
    expect(await screen.findByText(/gateway proxy/i)).toBeInTheDocument()
    expect(screen.queryByText(/tavily/i)).not.toBeInTheDocument()
  })

  it('sets a value for an unset credential', async () => {
    renderSection('settings')
    await screen.findByText(/gateway proxy/i)

    const input = screen.getByRole('textbox')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'http://proxy' } })
    fireEvent.click(await screen.findByRole('button', { name: /save/i }))

    await waitFor(() => expect(setVar).toHaveBeenCalledWith('GATEWAY_PROXY', 'http://proxy'))
  })
})
