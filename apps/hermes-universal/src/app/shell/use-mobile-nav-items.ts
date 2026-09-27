import '@/app/shell/nav-contrib'

import { useStore } from '@nanostores/react'
import { useMemo } from 'react'
import { useLocation, useNavigate } from 'react-router'

import { SIDEBAR_NAV_AREA, type SidebarNavContribution } from '@/app/routes'
import type { MobileNavRailItem } from '@/app/shell/mobile-nav-rail'
import { useContributions } from '@/contrib/react/use-contributions'
import { useI18n } from '@/i18n'
import { openCommandPalette } from '@/store/command-palette'
import { $interfaceMode, shownInMode } from '@/store/interface-mode'

/** Short captions under rail icons; `aria-label` keeps the full desktop string. */
const RAIL_SHORT_LABEL: Record<string, string> = {
  'new-session': 'New',
  artifacts: 'Arts',
  capabilities: 'Caps',
  cron: 'Cron',
  messaging: 'Msg',
  search: 'Search'
}

function railShortLabel(id: string, full: string): string {
  return RAIL_SHORT_LABEL[id] ?? full
}

/**
 * SIDEBAR_NAV (+ search) as horizontal rail items for the Sessions window.
 * Optional `onAfterSelect` closes an overlay after a tap.
 */
export function useMobileNavItems(onAfterSelect?: () => void): readonly MobileNavRailItem[] {
  const { t } = useI18n()
  const navigate = useNavigate()
  const location = useLocation()
  const interfaceMode = useStore($interfaceMode)
  const navContributions = useContributions(SIDEBAR_NAV_AREA)

  return useMemo(() => {
    const rows = navContributions
      .flatMap(c => {
        const data = c.data as Partial<SidebarNavContribution> | undefined

        if (!data || !(data.label || data.labelKey) || !(data.run || data.path?.startsWith('/'))) {
          return []
        }

        return [
          {
            icon: data.codicon || 'plug',
            id: c.id,
            label:
              data.label ??
              t.sidebar.nav[(data.labelKey ?? c.id) as keyof typeof t.sidebar.nav] ??
              c.id,
            run: data.run,
            route: data.path,
            tier: data.tier
          }
        ]
      })
      .filter(shownInMode(interfaceMode))

    const items: MobileNavRailItem[] = rows.map(row => ({
      active: row.route != null && location.pathname.startsWith(row.route),
      ariaLabel: row.label,
      icon: row.icon,
      id: row.id,
      label: railShortLabel(row.id, row.label),
      onSelect: () => {
        if (row.run) {
          row.run()
        } else if (row.route) {
          navigate(row.route)
        }

        onAfterSelect?.()
      }
    }))

    const searchFull = t.titlebar.search

    items.push({
      ariaLabel: searchFull,
      icon: 'search',
      id: 'search',
      label: railShortLabel('search', searchFull),
      onSelect: () => {
        openCommandPalette()
        onAfterSelect?.()
      }
    })

    return items
  }, [interfaceMode, location.pathname, navContributions, navigate, onAfterSelect, t])
}
