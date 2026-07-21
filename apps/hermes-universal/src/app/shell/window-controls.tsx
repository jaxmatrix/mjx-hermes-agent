import { getCurrentWindow } from '@tauri-apps/api/window'
import { useEffect, useState } from 'react'

import { Codicon } from '@/components/ui/codicon'
import { useI18n } from '@/i18n'

import { TitlebarButton } from './titlebar-button'

// Custom minimize / maximize-restore / close for the frameless window. Desktop
// (apps/desktop) leaves these to the OS; universal draws its own so the whole
// chrome is ours. Only mounted on desktop Tauri (see Titlebar / IS_DESKTOP).
export function WindowControls() {
  const { t } = useI18n()
  const [maximized, setMaximized] = useState(false)
  const win = getCurrentWindow()

  // Keep the maximize/restore glyph in sync with the actual window state
  // (toolbar click, double-click on the drag band, OS snap, etc.).
  useEffect(() => {
    let active = true
    let unlisten: (() => void) | undefined

    const sync = () => {
      void win
        .isMaximized()
        .then(v => active && setMaximized(v))
        .catch(() => {})
    }

    sync()
    void win
      .onResized(sync)
      .then(fn => (active ? (unlisten = fn) : fn()))
      .catch(() => {})

    return () => {
      active = false
      unlisten?.()
    }
  }, [win])

  return (
    <div className="flex items-center gap-0.5">
      <TitlebarButton label={t.titlebar.minimize} onClick={() => void win.minimize()}>
        <Codicon name="chrome-minimize" />
      </TitlebarButton>
      <TitlebarButton
        label={maximized ? t.titlebar.restore : t.titlebar.maximize}
        onClick={() => void win.toggleMaximize()}
      >
        <Codicon name={maximized ? 'chrome-restore' : 'chrome-maximize'} />
      </TitlebarButton>
      <TitlebarButton
        className="hover:bg-destructive hover:text-destructive-foreground"
        label={t.titlebar.close}
        onClick={() => void win.close()}
      >
        <Codicon name="chrome-close" />
      </TitlebarButton>
    </div>
  )
}
