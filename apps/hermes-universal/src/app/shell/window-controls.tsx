import { getCurrentWindow } from '@tauri-apps/api/window'
import { useEffect, useState } from 'react'

import { useI18n } from '@/i18n'
import { Minus, Square, Squares, X } from '@/lib/icons'

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
        <Minus className="size-3.5" />
      </TitlebarButton>
      <TitlebarButton
        label={maximized ? t.titlebar.restore : t.titlebar.maximize}
        onClick={() => void win.toggleMaximize()}
      >
        {maximized ? <Squares className="size-3.5" /> : <Square className="size-3.5" />}
      </TitlebarButton>
      <TitlebarButton
        className="hover:bg-destructive hover:text-destructive-foreground"
        label={t.titlebar.close}
        onClick={() => void win.close()}
      >
        <X className="size-3.5" />
      </TitlebarButton>
    </div>
  )
}
