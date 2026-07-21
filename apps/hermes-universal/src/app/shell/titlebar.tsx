import { useNavigate } from 'react-router-dom'

import { Codicon } from '@/components/ui/codicon'
import { useI18n } from '@/i18n'
import { useStore } from '@/store/atom'
import { openCommandMenu } from '@/store/command-menu'
import { $hapticsMuted } from '@/store/haptics'
import {
  $leftEdgeOpen,
  $panesFlipped,
  $rightEdgeOpen,
  toggleLeftEdge,
  togglePanesFlipped,
  toggleRightEdge
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
  // Positional, not pane-identity: each cluster's toggle drives whatever sits on
  // its own side of main, so a swap never leaves a button lying about its pane.
  const leftEdgeOpen = useStore($leftEdgeOpen)
  const rightEdgeOpen = useStore($rightEdgeOpen)

  return (
    <div
      // pointer-events-none so the transparent band lets clicks reach whatever is
      // beneath it (the in-pane chat title, aligned into this band). Interactive
      // bits below re-enable pointer events; a right-side strip stays draggable.
      className="pointer-events-none absolute inset-x-0 top-0 z-40 flex h-(--titlebar-height) w-full shrink-0 items-center gap-0.5 bg-transparent px-2 select-none"
    >
      {connected && (
        <div className="pointer-events-auto flex items-center gap-0.5">
          <TitlebarButton
            active={leftEdgeOpen}
            label={leftEdgeOpen ? t.titlebar.hideSidebar : t.titlebar.showSidebar}
            onClick={toggleLeftEdge}
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

      {/* The session title lives inside the chat pane (see chat-header.tsx),
          aligned into THIS band. The left portion of the middle passes clicks
          through to that title (pointer-events-none, inherited); the right
          portion stays a draggable window region for moving the frameless
          window. Title is left-aligned so it never falls under the drag strip. */}
      <div className="h-full flex-[4]" />
      <div className="pointer-events-auto h-full flex-1" data-tauri-drag-region />

      {connected && (
        <div className="pointer-events-auto flex items-center gap-0.5">
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
            active={rightEdgeOpen}
            label={rightEdgeOpen ? t.titlebar.hideRightSidebar : t.titlebar.showRightSidebar}
            onClick={toggleRightEdge}
          >
            <Codicon name="layout-sidebar-right" />
          </TitlebarButton>
        </div>
      )}

      <div className="pointer-events-auto flex items-center">
        <WindowControls />
      </div>
    </div>
  )
}
