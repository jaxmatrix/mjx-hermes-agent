import { useEffect, useState } from 'react'

import { useKeyboardInset } from '@/hooks/use-keyboard-inset'

// The root mobile layout. A phone takes this branch (IS_MOBILE) instead of the
// docked tile tree or the sub-768 AppShell drawer, so the touch layout is never
// entangled with the desktop drag/resize surfaces.
//
// Right now it renders a SAFE-AREA + KEYBOARD verification marker rather than
// real UI: the reserved insets are painted as solid strips with live px values,
// and a bottom-docked input lets you watch how the keyboard interacts with the
// area (it lifts by --keyboard-inset; the readout shows whether this webview
// even reports the keyboard via visualViewport). A device screenshot then makes
// the behaviour obvious. Insets come from lib/safe-area.ts + use-keyboard-inset.

interface Insets {
  top: string
  right: string
  bottom: string
  left: string
}

const ZERO: Insets = { top: '0px', right: '0px', bottom: '0px', left: '0px' }

// Read the published safe-area CSS vars back off :root so the marker shows the
// SAME value the layout is padded with. Re-reads for a while to catch the
// webview resolving env() late (the on-load race lib/safe-area.ts guards), then
// on rotation.
function useSafeAreaInsets(): Insets {
  const [insets, setInsets] = useState<Insets>(ZERO)

  useEffect(() => {
    const read = () => {
      const cs = getComputedStyle(document.documentElement)

      setInsets({
        top: cs.getPropertyValue('--safe-area-inset-top').trim() || '0px',
        right: cs.getPropertyValue('--safe-area-inset-right').trim() || '0px',
        bottom: cs.getPropertyValue('--safe-area-inset-bottom').trim() || '0px',
        left: cs.getPropertyValue('--safe-area-inset-left').trim() || '0px'
      })
    }

    read()

    const timers = [50, 150, 400, 1_000].map(ms => window.setTimeout(read, ms))

    window.addEventListener('resize', read)
    window.addEventListener('orientationchange', read)

    return () => {
      timers.forEach(t => window.clearTimeout(t))
      window.removeEventListener('resize', read)
      window.removeEventListener('orientationchange', read)
    }
  }, [])

  return insets
}

export function MobileShell() {
  const insets = useSafeAreaInsets()
  const keyboard = useKeyboardInset()

  return (
    // The OUTER strips are painted magenta and sized by the insets, so the top /
    // bottom safe areas are directly visible. If the safe area is handled, these
    // strips line up with the status bar / notch (top) and home indicator
    // (bottom); if the webview reports 0, the strips collapse and content runs
    // under the system UI.
    <div
      className="flex h-full min-h-0 flex-col"
      style={{
        backgroundColor: '#ff2d55',
        paddingTop: 'var(--safe-area-inset-top)',
        paddingRight: 'var(--safe-area-inset-right)',
        paddingBottom: 'var(--safe-area-inset-bottom)',
        paddingLeft: 'var(--safe-area-inset-left)'
      }}
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
        {/* The marked TOP BAR — sits immediately below the top safe-area strip. */}
        <div
          className="flex h-12 shrink-0 items-center justify-between px-4 font-mono text-xs font-semibold text-white"
          style={{ backgroundColor: '#0a84ff' }}
        >
          <span>TOP BAR</span>
          <span>safe-top: {insets.top}</span>
        </div>

        <main className="flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-1 font-mono text-xs text-(--ui-text-secondary)">
          <p className="text-sm font-semibold text-(--ui-text-primary)">Safe-area + keyboard check</p>
          <p>safe top / bottom: {insets.top} / {insets.bottom}</p>
          <p>safe left / right: {insets.left} / {insets.right}</p>
          <p className="mt-2 text-(--ui-text-primary)">
            keyboard inset: <span style={{ color: keyboard.open ? '#0a84ff' : undefined }}>{keyboard.inset}px</span>
          </p>
          <p>
            innerH {keyboard.innerHeight} · vvH {keyboard.viewportHeight} · offY {keyboard.offsetTop}
          </p>
          <p className="mt-2 text-(--ui-text-tertiary)">magenta strips = safe area · tap the input below</p>
        </main>

        {/* Bottom-docked input. It lifts by --keyboard-inset so it should stay
            ABOVE the keyboard; if the inset stays 0 (webview doesn't report the
            keyboard) it gets covered — which is exactly what we're verifying. */}
        <div
          className="shrink-0 border-t border-(--ui-stroke-secondary) bg-(--dt-card) p-3"
          style={{ marginBottom: 'var(--keyboard-inset, 0px)' }}
        >
          <input
            aria-label="Keyboard test input"
            className="w-full rounded-md border border-(--ui-stroke-secondary) bg-background px-3 py-2 text-(--ui-text-primary) outline-none"
            // 16px avoids iOS auto-zoom on focus (inputs < 16px zoom in).
            style={{ fontSize: '16px' }}
            placeholder="Tap here to open the keyboard"
            type="text"
          />
        </div>
      </div>
    </div>
  )
}
