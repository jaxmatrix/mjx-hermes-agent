import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Same shim as use-statusbar-items.test.tsx: keep the health poller / getStatus
// off the network while the list renders.
vi.mock('@/store/system-status', async () => {
  const { atom } = await import('nanostores')

  return {
    $appVersion: atom<string | null>('1.2.3'),
    $gatewayRestarting: atom(false),
    $inferenceStatus: atom(null),
    $statusSnapshot: atom(null),
    runGatewayRestart: vi.fn()
  }
})

import { $pluginRecords } from '@/contrib/plugins-store'
import { registry } from '@/contrib/registry'
import { resetChat } from '@/store/chat'

import { MobileStatusList } from './mobile-status-list'

const renderList = () =>
  render(
    <MemoryRouter>
      <MobileStatusList />
    </MemoryRouter>
  )

afterEach(() => {
  resetChat()
  $pluginRecords.set({})
})

describe('MobileStatusList', () => {
  it('groups the core inventory into its named sections', () => {
    renderList()

    expect(screen.getByText('Status')).toBeInTheDocument()
    expect(screen.getByText('System')).toBeInTheDocument()
    // The Plugins section heading covers the manage row — the word appears once
    // (desktop-shaped: heading, not heading + duplicate row label).
    expect(screen.getAllByText('Plugins')).toHaveLength(1)
  })

  // Before this, an id claimed by no SECTION was dropped on the floor — which is
  // every plugin contribution, since SECTIONS lists only core ids.
  it('surfaces an unclaimed contribution in the Plugins section', () => {
    const dispose = registry.register({
      area: 'statusBar.left',
      data: { detail: '3', id: 'demo:queue', label: 'Queue', variant: 'text' },
      id: 'demo:queue',
      source: 'plugin:demo'
    })

    renderList()

    expect(screen.getByText('Queue')).toBeInTheDocument()

    // Section heading, then the contribution (and any other unclaimed core rows).
    const labels = screen.getAllByText(/^(Plugins|Queue)$/).map(el => el.textContent)
    expect(labels[0]).toBe('Plugins')
    expect(labels).toContain('Queue')

    dispose()
  })

  it('does not paint plugin-record inventory counts on the status list', () => {
    $pluginRecords.set({
      broken: { id: 'broken', kind: 'disk', name: 'broken', status: 'error' },
      kanban: { id: 'kanban', kind: 'disk', name: 'kanban', status: 'loaded' },
      off: { id: 'off', kind: 'disk', name: 'off', status: 'disabled' }
    })

    renderList()

    // Inventory lives on Settings ▸ Plugins; the statusbar no longer emits a
    // `plugins` row with loaded/failed counts. The trailing section heading remains.
    expect(screen.getByText('Plugins')).toBeInTheDocument()
    expect(screen.queryByText('1 · 1 failed')).not.toBeInTheDocument()
  })

  it('passes a render contribution through untouched — no row rewriting', () => {
    const dispose = registry.register({
      area: 'statusBar.right',
      id: 'demo:chip',
      render: () => <output data-testid="chip">live</output>,
      source: 'plugin:demo'
    })

    renderList()

    expect(screen.getByTestId('chip').textContent).toBe('live')

    dispose()
  })
})
