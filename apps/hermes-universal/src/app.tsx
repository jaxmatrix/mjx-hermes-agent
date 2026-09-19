import { type ComponentType, lazy, type LazyExoticComponent, Suspense, useState } from 'react'

import { BackgroundCloseDialog } from '@/app/background-close-dialog'
import { SshPromptDialog } from '@/app/gateway/ssh-prompt-dialog'
import type { QUICK_ENTRY_SURFACE } from '@/app/quick-entry/quick-entry'
import { WakeIndicatorOverlay } from '@/app/wake-indicator-overlay'
import { IS_MOBILE } from '@/lib/platform'
import { startDeepLinkRouter } from '@/store/deep-link'
import { HUD_SURFACE, isActivityWindow, isTileWindow, satelliteSurface, WAKE_INDICATOR_SURFACE } from '@/store/windows'

/**
 * What this window is. Constant for the window's life — the platform is decided
 * at boot and the window kind is in the URL — so it is read once, synchronously,
 * before anything is chosen.
 */
type WindowKind = 'activity' | 'desktop' | 'hud' | 'phone' | 'quick' | 'tile' | 'wake'

function windowKind(): WindowKind {
  // A native screen activity (`?win=activity`, Android/iOS) renders a single
  // full-screen windowable surface — Settings / Command Center / Profiles, chosen
  // live by the current route — with its own top bar + Home, bypassing the chat
  // shell (MJX-141).
  if (isActivityWindow()) {
    return 'activity'
  }

  const surface = satelliteSurface()

  // The HUD (`?win=hud`) — a floating surface over other applications, holding
  // the same conversation the summoning window had (MJXHRM-213). Not a detached
  // pane: a different SHAPE of the app, in a native surface negotiated before
  // this code runs (`lib/surface.ts`).
  if (surface === HUD_SURFACE) {
    return 'hud'
  }

  // Quick Entry (`?win=quick`) — a one-line capture surface summoned by a global
  // chord (MJXHRM-384): a single prompt with no gateway of its own, handed to
  // the primary window to send. The literal, tied to the constant by type: the
  // module that owns it is part of Quick Entry's own chunk.
  const quick: typeof QUICK_ENTRY_SURFACE = 'quick'

  if (surface === quick) {
    return 'quick'
  }

  // The wake indicator (`?win=wake`) — a light over other applications saying
  // the phrase was heard (MJXHRM-228). It takes no input, no focus and no route,
  // and it is opened and closed by the state it mirrors rather than by the user.
  if (surface === WAKE_INDICATOR_SURFACE) {
    return 'wake'
  }

  // A tile window (`?win=tile`, or the legacy `?win=secondary`) hosts exactly
  // ONE tile — a detached pane, or the single-chat pop-out — bypassing the full
  // shell/overlays entirely (MJX-104, generalized in MJXHRM-173).
  if (isTileWindow()) {
    return 'tile'
  }

  // The window a desktop user works in is desktop's own root; what is left is
  // the phone (and a satellite surface nothing above claims).
  return IS_MOBILE || surface !== null ? 'phone' : 'desktop'
}

/**
 * One chunk per window kind: a window fetches, parses and links ITS tree and no
 * other. A phone never loads the desktop shell, the HUD never loads the phone's,
 * and under the dev server — native ESM, linked on demand — a root that does not
 * link yet cannot blank a window that never mounts it.
 *
 * `@/app/index` is desktop's root, exactly as desktop mounts it
 * (`ContribController`). Desktop's main.tsx does `import App from './app'`, where
 * `./app` resolves to that file; universal has a real `src/app.tsx` — this one —
 * and a file wins over a sibling directory, so the same specifier lands here.
 * The shadow is deliberate: it keeps main.tsx's import line desktop's.
 */
const ROOTS: Record<WindowKind, LazyExoticComponent<ComponentType>> = {
  activity: lazy(() => import('@/app/activity-screen').then(m => ({ default: m.ActivityScreenRoot }))),
  desktop: lazy(() => import('@/app/index')),
  hud: lazy(() => import('@/app/hud/hud-window').then(m => ({ default: m.HudWindowRoot }))),
  phone: lazy(() => import('@/app/mobile-controller').then(m => ({ default: m.MobileController }))),
  quick: lazy(() => import('@/app/quick-entry/quick-entry-window').then(m => ({ default: m.QuickEntryWindowRoot }))),
  tile: lazy(() => import('@/app/tile-window').then(m => ({ default: m.TileWindowRoot }))),
  wake: lazy(() =>
    import('@/app/wake-indicator/wake-indicator-window').then(m => ({ default: m.WakeIndicatorWindowRoot }))
  )
}

/** The hosts every universal root needs and desktop's root already has — see
 *  `app/window-hosts.tsx`. Their own chunk, fetched beside the root. */
const WindowHosts = lazy(() => import('@/app/window-hosts').then(m => ({ default: m.WindowHosts })))

/**
 * The root for this window, plus the surfaces that must exist in ALL of them.
 *
 * Three hosts are mounted here, statically, because desktop has no counterpart
 * for them and every window needs them from its first frame:
 *
 *  - `SshPromptDialog`: an SSH dial (a switch, a tunnel's Connect, an install)
 *    can ask for a credential or a host key from anywhere, so the window owns
 *    the question. Desktop runs `ssh` in batch mode and never asks.
 *  - `BackgroundCloseDialog`: the WINDOW close guard (`store/windows`) is
 *    installed at boot for any window that owns the app's persisted state, and
 *    parks the first close until this answers it. A window without it has a dead
 *    titlebar button. Desktop has no tray/background mode.
 *  - `WakeIndicatorOverlay` (MJXHRM-389): the in-window fallback light, and the
 *    driver of the native one. It renders nothing until "Hey Hermes" fires, and
 *    the window that armed the detector is not necessarily the one the app shell
 *    is in. On desktop that is Electron main's job.
 *
 * Everything else a universal root needs is `WindowHosts`. The DESKTOP MAIN
 * WINDOW skips it: `ContribController` / `ContribWiring` already mount
 * `AppContextMenu`, `ConfirmHost`, `FindBar`, `RemoteFolderPicker`,
 * `PluginInstallModal`, the MCP deep-link dialog, `SessionTileCloseConfirm`
 * (the close gate), the toasts and the palette, and `use-desktop-integrations`
 * arms the MCP health checker.
 *
 * The fallback is nothing at all. `#root` is already the window's own rectangle
 * and background before React renders (`styles.css`, `boot.ts`, and `main.tsx`'s
 * transparent claim for the HUD), so an empty root is the correct first frame
 * for every kind: no desktop chrome on a phone, nothing opaque in the HUD.
 */
export function App() {
  // Armed here, not in a root: a `hermes://` link is opened by the OS, and the
  // router claims only the window that owns the app's persisted state, so a
  // detached tile cannot race the main shell for the same link (MJXHRM-455).
  startDeepLinkRouter()

  const [kind] = useState(windowKind)
  const Root = ROOTS[kind]

  return (
    <>
      <Suspense fallback={null}>
        <Root />
        {kind !== 'desktop' && <WindowHosts />}
      </Suspense>
      <BackgroundCloseDialog />
      <SshPromptDialog />
      <WakeIndicatorOverlay />
    </>
  )
}

export default App
