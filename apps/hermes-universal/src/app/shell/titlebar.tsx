import { useNavigate } from 'react-router-dom'

import { useI18n } from '@/i18n'
import { ArrowsExchange, Keyboard, LayoutSidebar, Settings, Volume, VolumeOff } from '@/lib/icons'
import { $hapticsMuted } from '@/store/haptics'
import { useStore } from '@/store/atom'
import { $panesFlipped, togglePanesFlipped } from '@/store/layout'

import { useSidebar } from './sidebar'
import { TitlebarButton } from './titlebar-button'
import { WindowControls } from './window-controls'

// Custom window chrome: a transparent, draggable top strip (frameless window).
// Left cluster: sidebar toggle + swap-panes. Right cluster: haptics mute,
// shortcuts, settings — then the min/max/close controls. Icon color/hover match
// hermes-desktop's titlebar. The toolbar clusters only show once connected; the
// window controls + drag band are always present. Desktop-Tauri only (mounted
// behind IS_DESKTOP in MobileController).
export function Titlebar({ connected }: { connected: boolean }) {
  const { t } = useI18n()
  const { openMobile, toggle } = useSidebar()
  const navigate = useNavigate()
  const hapticsMuted = useStore($hapticsMuted)
  const panesFlipped = useStore($panesFlipped)

  return (
    <div
      className="flex h-(--titlebar-height) w-full shrink-0 items-center gap-0.5 bg-transparent px-2 select-none"
      data-tauri-drag-region
    >
      {connected && (
        <div className="flex items-center gap-0.5">
          <TitlebarButton
            label={openMobile ? t.titlebar.hideSidebar : t.titlebar.showSidebar}
            onClick={toggle}
          >
            <LayoutSidebar className="size-3.5" />
          </TitlebarButton>
          <TitlebarButton active={panesFlipped} label={t.titlebar.swapSidebarSides} onClick={togglePanesFlipped}>
            <ArrowsExchange className="size-3.5" />
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
            {hapticsMuted ? <VolumeOff className="size-3.5" /> : <Volume className="size-3.5" />}
          </TitlebarButton>
          <TitlebarButton label={t.titlebar.openKeybinds} onClick={() => navigate('/settings/shortcuts')}>
            <Keyboard className="size-3.5" />
          </TitlebarButton>
          <TitlebarButton label={t.titlebar.openSettings} onClick={() => navigate('/settings')}>
            <Settings className="size-3.5" />
          </TitlebarButton>
        </div>
      )}

      <WindowControls />
    </div>
  )
}
