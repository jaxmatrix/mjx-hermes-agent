import { useEffect, useState } from 'react'

// The root mobile layout. A phone takes this branch (IS_MOBILE) instead of the
// docked tile tree or the sub-768 AppShell drawer, so the touch layout is never
// entangled with the desktop drag/resize surfaces.
//
// Right now it renders a SAFE-AREA VERIFICATION marker rather than real UI: the
// reserved insets are painted as solid strips and their measured px values are
// shown live, so a device screenshot makes it obvious whether the webview is
// resolving the safe area correctly (and stably, not flashing at 0 on load).
// The padding reads the published `--safe-area-inset-*` vars (lib/safe-area.ts).

interface Insets {
  top: string
  right: string
  bottom: string
  left: string
}

const ZERO: Insets = { top: '0px', right: '0px', bottom: '0px', left: '0px' }

// Read the published CSS vars back off :root so the marker shows the SAME value
// the layout is padded with. Re-reads for a while to catch the webview resolving
// env() late (the on-load race lib/safe-area.ts also guards), then on rotation.
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
          <p className="text-sm font-semibold text-(--ui-text-primary)">Safe-area check</p>
          <p>top: {insets.top}</p>
          <p>right: {insets.right}</p>
          <p>bottom: {insets.bottom}</p>
          <p>left: {insets.left}</p>
          <p className="mt-2 text-(--ui-text-tertiary)">magenta strips = reserved safe area</p>
        </main>
      </div>
    </div>
  )
}
