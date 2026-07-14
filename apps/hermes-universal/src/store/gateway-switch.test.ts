import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/store/connection', () => ({ disconnect: vi.fn() }))

import { disconnect } from '@/store/connection'

import { $gatewayMode, $gatewaySwitching, switchGatewayMode } from './gateway-switch'

const mockDisconnect = vi.mocked(disconnect)

beforeEach(() => {
  localStorage.clear()
  $gatewayMode.set('remote')
})
afterEach(() => vi.clearAllMocks())

describe('gateway-switch', () => {
  it('defaults to remote', () => {
    expect($gatewayMode.get()).toBe('remote')
  })

  it('switching drops the live connection and updates the mode', () => {
    switchGatewayMode('cloud')
    expect(mockDisconnect).toHaveBeenCalledOnce()
    expect($gatewayMode.get()).toBe('cloud')
    expect($gatewaySwitching.get()).toBe(false)
  })

  it('is a no-op when already in the target mode', () => {
    switchGatewayMode('remote')
    expect(mockDisconnect).not.toHaveBeenCalled()
    expect($gatewayMode.get()).toBe('remote')
  })

  it('persists the selected mode to localStorage', () => {
    switchGatewayMode('local')
    expect(localStorage.getItem('hermes.gateway.mode')).toBe('local')
  })
})
