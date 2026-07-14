import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/store/gateway-switch', async () => {
  const { atom } = await import('@/store/atom')
  return { $gatewayMode: atom('remote'), switchGatewayMode: vi.fn() }
})

beforeEach(() => vi.resetModules())
afterEach(() => vi.clearAllMocks())

describe('ModePicker', () => {
  it('shows all three cards on desktop (LOCAL_MODE_SUPPORTED)', async () => {
    vi.doMock('@/lib/platform', () => ({ LOCAL_MODE_SUPPORTED: true }))
    const { ModePicker } = await import('./mode-picker')
    render(<ModePicker />)
    expect(screen.getByText('Local')).toBeInTheDocument()
    expect(screen.getByText('Cloud')).toBeInTheDocument()
    expect(screen.getByText('Remote')).toBeInTheDocument()
  })

  it('hides the Local card when local mode is unsupported (mobile)', async () => {
    vi.doMock('@/lib/platform', () => ({ LOCAL_MODE_SUPPORTED: false }))
    const { ModePicker } = await import('./mode-picker')
    render(<ModePicker />)
    expect(screen.queryByText('Local')).not.toBeInTheDocument()
    expect(screen.getByText('Cloud')).toBeInTheDocument()
    expect(screen.getByText('Remote')).toBeInTheDocument()
  })

  it('clicking a card switches mode', async () => {
    vi.doMock('@/lib/platform', () => ({ LOCAL_MODE_SUPPORTED: true }))
    const { ModePicker } = await import('./mode-picker')
    const { switchGatewayMode } = await import('@/store/gateway-switch')
    render(<ModePicker />)
    fireEvent.click(screen.getByText('Cloud'))
    expect(switchGatewayMode).toHaveBeenCalledWith('cloud')
  })
})
