import { useNavigate } from 'react-router-dom'

import { Codicon } from '@/components/ui/codicon'
import { useI18n } from '@/i18n'
import { $hapticsMuted } from '@/store/haptics'
import { openCommandMenu } from '@/store/command-menu'
import { useStore } from '@/store/atom'
import {
  $panesFlipped,
  $rightSidebarOpen,
  $sidebarOpen,
  toggleSidebarOpen,
  togglePanesFlipped,
  toggleRightSidebar
} from '@/store/layout'

import { TitlebarButton } from './titlebar-button'
import { WindowControls } from './window-controls'

// Custom window chrome: a transparent, draggable top strip (frameless window).
// Left cluster: sidebar toggle + swap-panes. Right cluster: haptics mute,
// shortcuts, settings, right-sidebar toggle — then the min/max/close controls.
// Icons are VS Code codicons — the SAME pack + glyph names hermes-desktop uses
// for its titlebar — so the two apps' chrome matches exactly. Toolbar clusters
// show once connected; the window controls + drag band are always present.
// Desktop-Tauri only (mounted behind IS_DESKTOP in MobileController).
export function Titlebar({ connected }: { connected: boolean }) {
  const { t } = useI18n()
  const navigate = useNavigate()
  const hapticsMuted = useStore($hapticsMuted)
  const panesFlipped = useStore($panesFlipped)
  const rightSidebarOpen = useStore($rightSidebarOpen)
  const sidebarOpen = useStore($sidebarOpen)

  return (
    <div
      className="absolute inset-x-0 top-0 z-40 flex h-(--titlebar-height) w-full shrink-0 items-center gap-0.5 bg-transparent px-2 select-none"
      data-tauri-drag-region
    >
      {connected && (
        <div className="flex items-center gap-0.5">
          <TitlebarButton
            active={sidebarOpen}
            label={sidebarOpen ? t.titlebar.hideSidebar : t.titlebar.showSidebar}
            onClick={toggleSidebarOpen}
          >
            <Codicon name="layout-sidebar-left" />
          </TitlebarButton>
          <TitlebarButton active={panesFlipped} label={t.titlebar.swapSidebarSides} onClick={togglePanesFlipped}>
            <Codicon name="arrow-swap" />
          </TitlebarButton>
          <TitlebarButton label={t.titlebar.searchTitle} onClick={openCommandMenu}>
            <Codicon name="search" />
          </TitlebarButton>
        </div>
      )}

      <div className="h-full flex-1" data-tauri-drag-region />

      {connected && (
        <div className="flex items-center gap-0.5">
          <TitlebarButton
            active={hapticsMuted}
            label={hapticsMuted ? t.titlebar.unmuteHaptics : t.titlebar.muteHaptics}
            onClick={() => $hapticsMuted.set(!$hapticsMuted.get())}
          >
            <Codicon name={hapticsMuted ? 'mute' : 'unmute'} />
          </TitlebarButton>
          <TitlebarButton label={t.titlebar.openKeybinds} onClick={() => navigate('/settings/shortcuts')}>
            <Codicon name="keyboard" />
          </TitlebarButton>
          <TitlebarButton label={t.titlebar.openSettings} onClick={() => navigate('/settings')}>
            <Codicon name="settings-gear" />
          </TitlebarButton>
          <TitlebarButton
            active={rightSidebarOpen}
            label={rightSidebarOpen ? t.titlebar.hideRightSidebar : t.titlebar.showRightSidebar}
            onClick={toggleRightSidebar}
          >
            <Codicon name="layout-sidebar-right" />
          </TitlebarButton>
        </div>
      )}

      <WindowControls />
    </div>
  )
}
