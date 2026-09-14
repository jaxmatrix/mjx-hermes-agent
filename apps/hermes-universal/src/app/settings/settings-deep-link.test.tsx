/**
 * The landing half of ⌘K settings search (MJXHRM-449 / MJXHRM-489): a result
 * navigates to `/settings/<section>?setting=…` or `?key=…`, and the page has to
 * find the row, focus it, flash it, and drop the param.
 *
 * The rows under test are the ones that have no config key at all, so nothing
 * in the schema-driven `?field=` path can reach them.
 */

import { QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
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
  deleteEnvVar: vi.fn(async () => ({ ok: true })),
  getEnvVars: vi.fn(async () => ({
    GATEWAY_PROXY: envVar({ category: 'setting', is_password: false }),
    TAVILY_API_KEY: envVar({ category: 'tool', description: 'Tavily search' })
  })),
  getHermesConfigRecord: vi.fn(async () => ({})),
  getHermesConfigSchema: vi.fn(async () => ({ fields: {} })),
  getProfiles: vi.fn(async () => ({ profiles: [] })),
  revealEnvVar: vi.fn(async (key: string) => ({ key, value: 'secret' })),
  saveHermesConfig: vi.fn(async () => ({ ok: true })),
  setApiRequestProfile: vi.fn(),
  setEnvVar: vi.fn(async () => ({ ok: true }))
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (_cmd: string, args: { maxMb?: number }) => args.maxMb ?? 16)
}))

import { I18nProvider } from '@/i18n'
import { queryClient } from '@/lib/query-client'

import { KeysSection } from './keys-section'
import { credentialRowElementId, settingRowElementId } from './settings-search'
import { SectionBody } from './settings-section'

function Search() {
  return <output data-testid="search">{useLocation().search}</output>
}

const renderAt = (entry: string, children: React.ReactNode) =>
  render(
    <MemoryRouter initialEntries={[entry]}>
      <I18nProvider>
        <QueryClientProvider client={queryClient}>
          {children}
          <Search />
        </QueryClientProvider>
      </I18nProvider>
    </MemoryRouter>
  )

const search = () => screen.getByTestId('search').textContent

beforeEach(() => queryClient.clear())
afterEach(() => {
  queryClient.clear()
  vi.clearAllMocks()
})

describe('?setting= deep links (client-pref rows)', () => {
  it('focuses and flashes the attachment-size row, then drops the param', async () => {
    renderAt('/settings/chat?setting=chat.attachment-size', <SectionBody section="chat" />)

    // Re-queried each tick: ConfigSection paints a skeleton first, so the row
    // this resolves against is not the element that existed at mount.
    const row = () => document.getElementById(settingRowElementId('chat.attachment-size'))

    // The fixture starts unflashed, so a no-op hook fails here rather than
    // passing on a class that was already present.
    expect(row()?.classList.contains('setting-field-highlight')).not.toBe(true)

    await waitFor(() => expect(row()?.classList.contains('setting-field-highlight')).toBe(true), { timeout: 3000 })
    expect(document.activeElement).toBe(row())
    await waitFor(() => expect(search()).toBe(''))
  })

  it('leaves the param in place while the named row is on another page', async () => {
    renderAt('/settings/chat?setting=workspace.terminal-host', <SectionBody section="chat" />)

    // Nothing on the Chat page carries that id, so there is nothing to flash…
    expect(document.getElementById(settingRowElementId('workspace.terminal-host'))).toBeNull()

    // …and the param must survive: dropping it eagerly would lose the deep link
    // if the row mounted a few frames later.
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(search()).toBe('?setting=workspace.terminal-host')
  })
})

describe('?key= deep links (credential rows)', () => {
  it('expands, focuses and flashes the named credential card', async () => {
    renderAt('/settings/keys?key=TAVILY_API_KEY', <KeysSection view="tools" />)

    await screen.findByText('TAVILY')

    const card = document.getElementById(credentialRowElementId('TAVILY_API_KEY'))

    expect(card).not.toBeNull()
    await waitFor(() => expect(card?.classList.contains('setting-field-highlight')).toBe(true), { timeout: 3000 })
    // onResolve expanded it — the description only renders on an open card.
    expect(screen.getByText('Tavily search')).toBeInTheDocument()
    await waitFor(() => expect(search()).toBe(''))
  })

  it('does not resolve a key that belongs to the other sub-tab', async () => {
    renderAt('/settings/keys?key=GATEWAY_PROXY', <KeysSection view="tools" />)

    await screen.findByText('TAVILY')
    await new Promise(resolve => setTimeout(resolve, 200))

    expect(document.getElementById(credentialRowElementId('GATEWAY_PROXY'))).toBeNull()
    expect(search()).toBe('?key=GATEWAY_PROXY')
  })
})
