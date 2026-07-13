import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { EnvVarInfo } from '@/types/hermes'

const envVar = (over: Partial<EnvVarInfo>): EnvVarInfo => ({
  advanced: false,
  category: 'providers',
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
    OPENAI_API_KEY: envVar({ description: 'OpenAI key', provider_label: 'OpenAI' }),
    ANTHROPIC_API_KEY: envVar({ description: 'Claude key', provider_label: 'Anthropic', is_set: true, redacted_value: 'sk-a...z9' })
  })),
  setEnvVar: vi.fn(async () => ({ ok: true })),
  revealEnvVar: vi.fn(async (key: string) => ({ key, value: 'super-secret' })),
  deleteEnvVar: vi.fn(async () => ({ ok: true }))
}))

import { revealEnvVar, setEnvVar } from '@/hermes'
import { I18nProvider } from '@/i18n'

import { KeysSection } from './keys-section'

const setVar = vi.mocked(setEnvVar)
const reveal = vi.mocked(revealEnvVar)

const renderSection = () =>
  render(
    <I18nProvider>
      <KeysSection />
    </I18nProvider>
  )

describe('KeysSection', () => {
  beforeEach(() => {
    setVar.mockClear()
    reveal.mockClear()
  })
  afterEach(() => localStorage.clear())

  it('lists env vars grouped by provider', async () => {
    renderSection()
    expect(await screen.findByText('OPENAI_API_KEY')).toBeInTheDocument()
    expect(screen.getByText('ANTHROPIC_API_KEY')).toBeInTheDocument()
    expect(screen.getByText('OpenAI')).toBeInTheDocument()
  })

  it('sets a value for an unset var', async () => {
    renderSection()
    await screen.findByText('OPENAI_API_KEY')
    fireEvent.change(screen.getByPlaceholderText('Paste key'), { target: { value: 'sk-new' } })
    fireEvent.click(screen.getByRole('button', { name: 'Set' }))
    await waitFor(() => expect(setVar).toHaveBeenCalledWith('OPENAI_API_KEY', 'sk-new'))
  })

  it('reveals a set var value', async () => {
    renderSection()
    await screen.findByText('ANTHROPIC_API_KEY')
    fireEvent.click(screen.getByRole('button', { name: 'Reveal value' }))
    await waitFor(() => expect(reveal).toHaveBeenCalledWith('ANTHROPIC_API_KEY'))
    expect(await screen.findByText('super-secret')).toBeInTheDocument()
  })
})
