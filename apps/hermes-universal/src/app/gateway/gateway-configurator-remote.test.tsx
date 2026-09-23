import { QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Type-only, so this is erased and cannot trip vi.mock's hoisting.
import type * as ConnectionModule from '@/store/connection'

// The remote row a form names is ONE thing, whichever button saves it: a gated
// gateway saved for the next restart without its `authMode` launched ungated and
// was refused (4401).

vi.mock('@/store/connections', () => ({
  applyConnection: vi.fn().mockResolvedValue('studio'),
  connectionById: vi.fn(),
  saveLaunchTarget: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('@/lib/secure-store', () => ({
  loadSshSecrets: vi.fn().mockResolvedValue({}),
  mergeSshSecrets: vi.fn().mockResolvedValue(undefined),
  saveSecrets: vi.fn().mockResolvedValue(undefined),
  loadSecrets: vi.fn().mockResolvedValue(null)
}))
vi.mock('@/store/connection', async importActual => ({
  ...(await importActual<typeof ConnectionModule>()),
  fetchAuthProviders: vi.fn().mockResolvedValue([]),
  probeStatus: vi.fn().mockResolvedValue({ auth_required: true })
}))

import { I18nProvider } from '@/i18n'
import { queryClient } from '@/lib/query-client'
import { probeStatus } from '@/store/connection'
import { applyConnection, saveLaunchTarget } from '@/store/connections'

import { GatewayConfigurator } from './gateway-configurator'

const GATED = { authMode: 'oauth', kind: 'remote', token: undefined, url: 'https://studio.test' }

/** Pick the remote card, name a gated gateway, and wait out the probe. */
async function nameGatedGateway(): Promise<void> {
  render(
    <I18nProvider>
      <QueryClientProvider client={queryClient}>
        <GatewayConfigurator variant="settings" />
      </QueryClientProvider>
    </I18nProvider>
  )

  fireEvent.click(screen.getByRole('button', { name: /^Remote gateway/ }))
  fireEvent.change(screen.getByPlaceholderText('https://gateway.example.com/hermes'), {
    target: { value: 'https://studio.test' }
  })

  await waitFor(() => expect(probeStatus).toHaveBeenCalled(), { timeout: 2000 })
  // The probe's answer has landed once the sign-in control replaces the token box.
  await screen.findByRole('button', { name: /^Sign in/ })
}

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
})

describe('GatewayConfigurator — a gated remote', () => {
  it('saves the same row for the next restart as Connect applies, its auth mode included', async () => {
    await nameGatedGateway()

    fireEvent.click(screen.getByRole('button', { name: 'Save for next restart' }))

    await waitFor(() => expect(saveLaunchTarget).toHaveBeenCalledOnce())
    expect(saveLaunchTarget).toHaveBeenCalledWith(GATED)

    fireEvent.click(screen.getByRole('button', { name: 'Save and reconnect' }))

    await waitFor(() => expect(applyConnection).toHaveBeenCalledOnce())
    expect(vi.mocked(applyConnection).mock.calls[0][0]).toEqual(GATED)
  })
})
