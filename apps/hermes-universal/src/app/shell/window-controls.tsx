import { getCurrentWindow } from '@tauri-apps/api/window'
import { useEffect, useState } from 'react'

import { Codicon } from '@/components/ui/codicon'
import { useI18n } from '@/i18n'

import { TitlebarButton } from './titlebar-button'

// Custom minimize / maximize-restore / close for the frameless window. Desktop
// (apps/desktop) leaves these to the OS; universal draws its own so the whole
// chrome is ours. Desktop Tauri only. Mounted by the tile window's own header,
// and by `WindowChrome` for the windows that render desktop's root.
//
// `leading` is the macOS order (close first, at the window's left corner);
// the default is the Windows/Linux one (close last, at the right corner).
export function WindowControls({ leading = false }: { leading?: boolean }) {
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

  const minimize = (
    <TitlebarButton key="minimize" label={t.titlebar.minimize} onClick={() => void win.minimize()}>
      <Codicon name="chrome-minimize" />
    </TitlebarButton>
  )

  const maximize = (
    <TitlebarButton
      key="maximize"
      label={maximized ? t.titlebar.restore : t.titlebar.maximize}
      onClick={() => void win.toggleMaximize()}
    >
      <Codicon name={maximized ? 'chrome-restore' : 'chrome-maximize'} />
    </TitlebarButton>
  )

  // `close()` is a REQUEST: it goes through the window close guard
  // (`store/windows`), which may park it behind the background-mode question.
  const close = (
    <TitlebarButton
      className="hover:bg-destructive hover:text-destructive-foreground"
      key="close"
      label={t.titlebar.close}
      onClick={() => void win.close()}
    >
      <Codicon name="chrome-close" />
    </TitlebarButton>
  )

  return (
    <div className="flex items-center gap-0.5">
      {leading ? [close, minimize, maximize] : [minimize, maximize, close]}
    </div>
  )
}
