/**
 * Universal's Gateways page as a contribution to desktop's workspace: it is a
 * route desktop's table renders, a ⌘K row that leads to it, and a status-bar
 * item that appears only while a tunnel has something to say.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Universal's own page is linked by `scripts/link-edges.mjs`; here it only has
// to be what the route mounts.
vi.mock('@/app/settings/connections', () => ({
  ConnectionsSection: () => <div data-testid="connections-section" />
}))

import { PALETTE_AREA, type PaletteContribution } from '@/app/command-palette/contrib'
import { contributedRoutes } from '@/app/routes'
import { ContribBoundary, ContribRender } from '@/contrib/react/boundary'
import { registry } from '@/contrib/registry'
import { $tunnelStatus } from '@/store/connection-tunnels'
import { $registryView, type ConnectionView, type RegistryView } from '@/store/connections'

import { registerUniversalPages } from './pages'
import { CONNECTIONS_PAGE_PATH } from './paths'
import { TunnelStatusChip } from './tunnel-status'

const base = {
  hasSshKey: false,
  hasSshPassphrase: false,
  hasSshPassword: false,
  hasToken: false,
  headerNames: [],
  legacy: false
}

const ROWS: ConnectionView[] = [
  { ...base, id: 'local', kind: 'local', label: 'This device', order: 0 },
  { ...base, host: 'box.internal', id: 'box', kind: 'ssh', label: 'Box', order: 1 },
  { ...base, id: 'home', kind: 'remote', label: 'Homelab', order: 2, url: 'https://home.test' }
]

const VIEW: RegistryView = {
  connections: ROWS,
  keyringAvailable: true,
  lastUsed: 'local',
  launchMode: 'last-used',
  localSupported: true,
  primary: 'local',
  readOnly: false,
  version: 2
}

const tunnel = (connectionId: string, phase: 'connecting' | 'failed' | 'ready', errorKind?: string) => ({
  connectionId,
  errorKind,
  generation: 1,
  phase,
  terminal: phase === 'failed'
})

let dispose: () => void = () => {}

/** As desktop's route table mounts a contributed page (`app/contrib/surfaces.tsx`). */
function renderRoute(): void {
  const route = contributedRoutes().find(entry => entry.path === CONNECTIONS_PAGE_PATH)

  render(
    <ContribBoundary id={route!.key}>
      <ContribRender render={route!.render} />
    </ContribBoundary>
  )
}

beforeEach(() => {
  window.location.hash = ''
  $registryView.set(VIEW)
  $tunnelStatus.set({})
  dispose = registerUniversalPages()
})

afterEach(() => {
  cleanup()
  dispose()
})

describe('the contributed Gateways page', () => {
  it('is a route of desktop’s workspace, registered once', () => {
    registerUniversalPages()

    expect(contributedRoutes().filter(route => route.path === CONNECTIONS_PAGE_PATH)).toHaveLength(1)
  })

  it('mounts universal’s own connections page, with the tunnels behind this window’s sources', async () => {
    $tunnelStatus.set({
      box: tunnel('box', 'failed', 'host-key-changed'),
      home: tunnel('home', 'ready'),
      local: tunnel('local', 'ready')
    })

    renderRoute()

    expect(await screen.findByTestId('universal-connections-page')).toBeInTheDocument()
    expect(screen.getByTestId('connections-section')).toBeInTheDocument()

    const lines = screen.getByTestId('tunnel-status').textContent ?? ''

    // Tunnelled sources only, in copy — a URL row has no tunnel, and nothing
    // here names a host.
    expect(lines).toContain('This device')
    expect(lines).toContain('Box')
    expect(lines).not.toContain('Homelab')
    expect(lines).not.toContain('box.internal')
  })

  it('leaves desktop’s route table when it is disposed', () => {
    dispose()

    expect(contributedRoutes().some(route => route.path === CONNECTIONS_PAGE_PATH)).toBe(false)
  })

  it('has a ⌘K row that leads to it', () => {
    const row = registry
      .getArea(PALETTE_AREA)
      .map(entry => entry.data as PaletteContribution)
      .find(entry => entry.id === 'universal.connections.open')

    expect(row?.label).toBe('Gateways')
    expect(row?.keywords).toEqual(expect.arrayContaining(['ssh', 'tunnel']))

    row?.run()

    expect(window.location.hash).toBe(`#${CONNECTIONS_PAGE_PATH}`)
  })
})

describe('the status bar’s way in', () => {
  it('is absent while every tunnel is healthy, or there is none', () => {
    const { container, rerender } = render(<TunnelStatusChip />)

    expect(container).toBeEmptyDOMElement()

    act(() => $tunnelStatus.set({ local: tunnel('local', 'ready') }))
    rerender(<TunnelStatusChip />)

    expect(container).toBeEmptyDOMElement()
  })

  it('names the source whose tunnel needs a person, and leads to the page', () => {
    $tunnelStatus.set({ box: tunnel('box', 'failed', 'credentials-needed') })

    render(<TunnelStatusChip />)

    fireEvent.click(screen.getByRole('button', { name: /Box/ }))

    expect(window.location.hash).toBe(`#${CONNECTIONS_PAGE_PATH}`)
  })

  it('is contributed to the right-hand side of desktop’s status bar', () => {
    expect(registry.getArea('statusBar.right').some(entry => entry.id === 'universal.connections.tunnels')).toBe(true)
  })
})
