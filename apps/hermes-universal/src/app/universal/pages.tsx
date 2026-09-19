/**
 * Universal's own pages, contributed to desktop's workspace.
 *
 * Desktop's Settings hardcodes its sections and is desktop's file, so a page
 * only universal has cannot become a section of it. Desktop already has the
 * other door: a `routes` contribution mounts a full page in the workspace pane,
 * a `palette` contribution is a ⌘K row, and a `statusBar.*` one is an item in
 * the bar (`app/routes.ts`, `app/command-palette/contrib.ts`, `contrib/registry`)
 * — the mechanism plugins use, used here as core (`source` unset), so it is not
 * a plugin a person can switch off.
 *
 * Registered from `boot.ts`, for the windows that render desktop's root. The
 * page itself is a lazy chunk: registering costs the first paint nothing.
 */

import { lazy, Suspense } from 'react'

import { PALETTE_AREA, type PaletteContribution } from '@/app/command-palette/contrib'
import { type RouteContribution, ROUTES_AREA } from '@/app/routes'
import { registry } from '@/contrib/registry'
import { translateNow } from '@/i18n/runtime'

import { CONNECTIONS_PAGE_PATH } from './paths'
import { TunnelStatusChip } from './tunnel-status'

const ConnectionsPage = lazy(() => import('./connections-page'))

let registered: null | (() => void) = null

/** Idempotent. Returns the disposer, for tests. */
export function registerUniversalPages(): () => void {
  registered ??= registry.registerMany([
    {
      area: ROUTES_AREA,
      data: { path: CONNECTIONS_PAGE_PATH } satisfies RouteContribution,
      id: 'universal.connections.page',
      render: () => (
        <Suspense fallback={null}>
          <ConnectionsPage />
        </Suspense>
      )
    },
    {
      area: PALETTE_AREA,
      data: {
        id: 'universal.connections.open',
        keywords: ['gateway', 'connection', 'ssh', 'key', 'tunnel', 'passphrase', 'cloud', 'sign in'],
        // Read at registration, as every contributed label is.
        label: translateNow('settings.connections.managePage'),
        run: () => {
          window.location.hash = `#${CONNECTIONS_PAGE_PATH}`
        }
      } satisfies PaletteContribution,
      id: 'universal.connections.open'
    },
    {
      area: 'statusBar.right',
      id: 'universal.connections.tunnels',
      order: 85,
      render: () => <TunnelStatusChip />
    }
  ])

  return () => {
    registered?.()
    registered = null
  }
}
