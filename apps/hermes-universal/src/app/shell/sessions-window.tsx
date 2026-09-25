import { type ReactNode, useRef, useState } from 'react'

import { MobileNavRail, type MobileNavRailItem } from '@/app/shell/mobile-nav-rail'
import { MobileWindowChrome } from '@/app/shell/mobile-window-chrome'
import { ProfileGlyph } from '@/components/ui/profile-glyph'
import { topBarBottom, TopDrawer, TopDrawerRow } from '@/components/ui/top-drawer'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'

export type SessionsWindowTab = 'bots' | 'sessions'

export interface SessionsWindowProfile {
  color: null | string
  id: string
  isDefault: boolean
  name: string
}

/**
 * Phone left window: Sessions|Bots tab strip (always both), profile button →
 * top drawer picker, body, bottom nav rail (Sessions tab only), ✕.
 * Presentational — live wiring supplies bodies and nav items; Storybook stubs them.
 *
 * Submenus on mobile are drawers (top or bottom), never floating DropdownMenus.
 * SIDEBAR_NAV (New / Caps / …) is the Sessions-tab bottom rail only — not on chat.
 */
export function SessionsWindow({
  activeTab,
  botsBody,
  navItems,
  onClose,
  onSelectProfile,
  onSelectTab,
  profiles,
  selectedProfileId,
  sessionsBody
}: {
  activeTab: SessionsWindowTab
  botsBody: ReactNode
  navItems: readonly MobileNavRailItem[]
  onClose: () => void
  onSelectProfile: (id: string) => void
  onSelectTab: (tab: SessionsWindowTab) => void
  profiles: readonly SessionsWindowProfile[]
  selectedProfileId: string
  sessionsBody: ReactNode
}) {
  const { t } = useI18n()
  const selected = profiles.find(p => p.id === selectedProfileId) ?? profiles[0]

  return (
    <MobileWindowChrome
      activeTabId={activeTab}
      body={
        <div className="flex h-full min-h-0 flex-1 flex-col">
          <div
            className="shrink-0 border-b border-(--ui-stroke-tertiary) px-2 py-1.5"
            data-top-bar=""
          >
            <ProfileMenuButton
              onSelectProfile={onSelectProfile}
              profiles={profiles}
              selected={selected}
            />
          </div>
          <div className="min-h-0 flex-1 overflow-hidden" data-slot="sessions-window-body">
            {activeTab === 'sessions' ? sessionsBody : botsBody}
          </div>
        </div>
      }
      bottom={
        activeTab === 'sessions' ? (
          <MobileNavRail aria-label={t.titlebar.showSidebar} items={navItems} />
        ) : undefined
      }
      data-slot="sessions-window"
      onClose={onClose}
      onSelectTab={id => onSelectTab(id as SessionsWindowTab)}
      tabs={[
        { id: 'sessions', label: t.sidebar.sessions },
        { id: 'bots', label: t.common.bots }
      ]}
      topBorder={false}
    />
  )
}

function ProfileMenuButton({
  onSelectProfile,
  profiles,
  selected
}: {
  onSelectProfile: (id: string) => void
  profiles: readonly SessionsWindowProfile[]
  selected: SessionsWindowProfile | undefined
}) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [offsetTop, setOffsetTop] = useState(0)
  const triggerRef = useRef<HTMLButtonElement>(null)

  if (!selected) {
    return null
  }

  return (
    <>
      <button
        className={cn(
          'flex w-full items-center gap-2 rounded-md px-2 py-2 text-start text-sm',
          'hover:bg-[var(--ui-control-hover-background)]'
        )}
        data-slot="sessions-window-profile"
        onClick={() => {
          setOffsetTop(topBarBottom(triggerRef.current))
          setOpen(true)
        }}
        ref={triggerRef}
        type="button"
      >
        <ProfileGlyph color={selected.color} isDefault={selected.isDefault} name={selected.name} />
        <span className="min-w-0 flex-1 truncate font-medium">{selected.name}</span>
        <span className="text-muted-foreground text-xs">▾</span>
      </button>

      <TopDrawer
        offsetTop={offsetTop}
        onOpenChange={setOpen}
        open={open}
        title={t.sidebar.profileRail}
      >
        {profiles.map(profile => (
          <TopDrawerRow
            active={profile.id === selected.id}
            key={profile.id}
            onSelect={() => {
              onSelectProfile(profile.id)
              setOpen(false)
            }}
          >
            <ProfileGlyph color={profile.color} isDefault={profile.isDefault} name={profile.name} />
            <span className="min-w-0 flex-1 truncate">{profile.name}</span>
          </TopDrawerRow>
        ))}
      </TopDrawer>
    </>
  )
}
