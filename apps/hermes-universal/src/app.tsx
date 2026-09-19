import { ActivityScreenRoot } from '@/app/activity-screen'
import { BackgroundCloseDialog } from '@/app/background-close-dialog'
import { CloseConfirm } from '@/app/close-confirm'
import { AppContextMenu } from '@/app/context-menu/coordinator'
import { ExplorerPathDialog } from '@/app/explorer-path-dialog'
import { SshPromptDialog } from '@/app/gateway/ssh-prompt-dialog'
import { HUD_SURFACE } from '@/app/hud/hud'
import { HudWindowRoot } from '@/app/hud/hud-window'
import DesktopRoot from '@/app/index'
import { McpInstallDeepLinkDialog } from '@/app/mcp-install-deeplink-dialog'
import { MobileController } from '@/app/mobile-controller'
import { QUICK_ENTRY_SURFACE } from '@/app/quick-entry/quick-entry'
import { QuickEntryWindowRoot } from '@/app/quick-entry/quick-entry-window'
import { RemoteFolderPicker } from '@/app/right-pane/files/remote-picker'
import { PluginInstallModal } from '@/app/settings/plugin-install-modal'
import { TileWindowRoot } from '@/app/tile-window'
import { WakeIndicatorOverlay } from '@/app/wake-indicator-overlay'
import { WakeIndicatorWindowRoot } from '@/app/wake-indicator/wake-indicator-window'
import { ConfirmHost } from '@/components/confirm-host'
import { FindBar } from '@/components/find-bar'
import { IS_MOBILE } from '@/lib/platform'
import { startDeepLinkRouter } from '@/store/deep-link'
import { startMcpHealthChecker } from '@/store/mcp-health'
import {
  isActivityWindow,
  isSatelliteWindow,
  isTileWindow,
  satelliteSurface,
  WAKE_INDICATOR_SURFACE
} from '@/store/windows'

/**
 * Every window root, plus the surfaces that must exist in ALL of them.
 *
 * `RemoteFolderPicker` is one such surface: it is not a view, it is the
 * registration that gives `selectDesktopPaths` / `selectRemotePaths` somewhere
 * to send a pick. Unregistered, both resolve `[]`, which every caller reads as
 * "cancelled" — so the composer's `Files… ▸ Remote…`, Settings ▸ Archived's
 * "choose folder" and Profiles ▸ import were dead clicks in exactly the roots
 * that skip `ContribController`: the detached tile window, the HUD, and the
 * Android/iOS activity screen (which IS the Settings/Profiles surface there).
 *
 * `FindBar` (MJXHRM-387) is the second. It used to mount inside
 * `MobileController` only, so ⌘F searched the main shell and nothing else —
 * dead in a detached chat window showing a whole transcript, dead in the HUD
 * holding the same conversation, dead on the Android activity screen. It renders
 * nothing until opened and carries its own accelerator where no dispatcher
 * exists, so mounting it per window is free.
 *
 * `WakeIndicatorOverlay` (MJXHRM-389) is the fourth, for the same reason as
 * `FindBar`: it renders nothing until "Hey Hermes" fires, and the window that
 * armed the detector is not necessarily the one the app shell is in. Mounting it
 * per root costs one atom subscription and removes the question entirely.
 *
 * `CloseConfirm` (MJXHRM-390) is the third, and it was the same mistake one
 * level down: the "close a working chat?" gate mounted inside
 * `ContribController`, i.e. only in the DOCKED TILE TREE. A phone renders
 * `MobileShell` and a narrow window renders `AppShell`, so on both the gate
 * could park a pending close and nothing would ever draw the question — which
 * is why the mobile bubble strip dropped a chat mid-turn without asking.
 *
 * `ExplorerPathDialog` is the sixth, and it is the `CloseConfirm` shape again:
 * "move this chat to this folder, or only start new ones there?" is asked by a
 * titlebar button, a tree row's context menu and a search hit's kebab — three
 * transient surfaces, one of which Radix unmounts the instant it is selected.
 * The asker cannot own the dialog, so the window does.
 *
 * `BackgroundCloseDialog` is the fifth, and it is the same shape as
 * `CloseConfirm`: the WINDOW close guard is installed at boot for any window
 * that owns the app's persisted state, so the surface that answers it has to
 * exist wherever that guard does. A window whose shell forgot it would park the
 * first close and never draw the question, which is a dead titlebar button.
 *
 * `AppContextMenu` (MJXHRM-478) is the ninth, and it is the sharpest case of
 * the same rule: on Tauri every engine pops its OWN context menu for a gesture
 * the page does not cancel, so a root without the coordinator does not merely
 * lose the Hermes menu — it shows WebKitGTK's "Reload / Inspect Element" over
 * the app instead. Right-click and long-press exist in every window.
 *
 * `ConfirmHost` (MJXHRM-479) is the sixth, and it is the strongest case of all:
 * `confirm()` is called from plain async handlers and store actions that have no
 * component of their own, so the promise is parked with NOTHING on screen unless
 * a host is mounted in that window. A settings panel, a command-center action
 * and a sidebar row each reach it from a different shell, so the shell level is
 * again one level too low.
 *
 * `PluginInstallModal` (MJXHRM-455) is the eighth, and it is the seventh's
 * twin: `hermes://plugin/install` is the same "an outside link asked for
 * something" shape, and the same window must be able to draw the question.
 *
 * `McpInstallDeepLinkDialog` (MJXHRM-454) is the seventh, and it is the
 * `ConfirmHost` case again from outside the app: a `hermes://mcp/install` link
 * is opened by the OS, so whichever window happens to be listening has to be
 * able to draw the confirmation — and nothing is written to config until it is
 * answered. The router is armed here for the same reason — and it claims only
 * the window that owns the app's persisted state, so a detached tile cannot
 * race the main shell for the same link (MJXHRM-455).
 *
 * Mounted HERE rather than once per root so the next root cannot forget them —
 * the failure mode is silence, which is the kind that ships.
 *
 * THE DESKTOP MAIN WINDOW IS THE EXCEPTION, because its root is desktop's own
 * (`DesktopMainWindow` below), and desktop's `ContribWiring` already mounts its
 * twin of most of this list. Mounting both would draw the same question twice.
 */
export function App() {
  startDeepLinkRouter()

  if (isDesktopMainWindow()) {
    return <DesktopMainWindow />
  }

  // Both are idempotent and refuse to arm twice; the health checker also
  // refuses in a satellite window, so the fleet gets ONE sweeper.
  startMcpHealthChecker()

  return (
    <>
      <AppRoot />
      <RemoteFolderPicker />
      <FindBar />
      <CloseConfirm />
      <BackgroundCloseDialog />
      {/* "Move this chat to this folder, or only start new ones there?" is asked
          from a tree row's context menu and a search hit's menu — transient
          surfaces Radix unmounts the instant a row is selected — so the window
          owns the dialog, like CloseConfirm. */}
      <ExplorerPathDialog />
      <ConfirmHost />
      {/* Any SSH dial can ask for a credential or a host key — a switch, a
          tunnel's Connect, an install — so the window owns the question. */}
      <SshPromptDialog />
      <AppContextMenu />
      <McpInstallDeepLinkDialog />
      <PluginInstallModal />
      <WakeIndicatorOverlay />
    </>
  )
}

/** The window a desktop user works in: not a phone, and not a tile, satellite
 *  or activity screen. Constant for the window's life — the platform is decided
 *  at boot and the window kind is in the URL. */
function isDesktopMainWindow(): boolean {
  return !IS_MOBILE && !isActivityWindow() && !isTileWindow() && !isSatelliteWindow()
}

/**
 * Desktop's root, exactly as desktop mounts it (`app/index.tsx` →
 * `ContribController`), plus the hosts desktop has no counterpart for.
 *
 * `ContribController` / `ContribWiring` already mount `AppContextMenu`,
 * `ConfirmHost`, `FindBar`, `RemoteFolderPicker`, `PluginInstallModal`, the MCP
 * deep-link dialog, `SessionTileCloseConfirm` (the close gate), the toasts and
 * the palette, and `use-desktop-integrations` arms the MCP health checker — so
 * none of those is repeated here. What is left is universal-only:
 *
 *  - `SshPromptDialog`: an SSH dial (a switch, a tunnel's Connect, an install)
 *    can ask for a credential or a host key from anywhere. Desktop runs `ssh`
 *    in batch mode and never asks.
 *  - `BackgroundCloseDialog`: the window close guard (`store/windows`) parks the
 *    first close until this answers it. Desktop has no tray/background mode.
 *  - `WakeIndicatorOverlay`: the in-window fallback light, and the driver of the
 *    native one. On desktop that is Electron main's job.
 */
function DesktopMainWindow() {
  return (
    <>
      <DesktopRoot />
      <SshPromptDialog />
      <BackgroundCloseDialog />
      <WakeIndicatorOverlay />
    </>
  )
}

function AppRoot() {
  // A native screen activity (`?win=activity`, Android/iOS) renders a single
  // full-screen windowable surface — Settings / Command Center / Profiles, chosen
  // live by the current route — with its own top bar + Home, bypassing the chat
  // shell (MJX-141).
  if (isActivityWindow()) {
    return <ActivityScreenRoot />
  }

  // The HUD (`?win=hud`) — a floating surface over other applications, holding
  // the same conversation the summoning window had (MJXHRM-213). Branched here
  // rather than inside the tile root because it is not a detached pane: it is a
  // different SHAPE of the app, and the window it lives in is a native surface
  // negotiated before this code runs (`lib/surface.ts`).
  if (satelliteSurface() === HUD_SURFACE) {
    return <HudWindowRoot />
  }

  // Quick Entry (`?win=quick`) — a one-line capture surface summoned by a global
  // chord (MJXHRM-384). Branched beside the HUD because it is the same KIND of
  // thing and the opposite trade: the HUD is the whole conversation moved
  // somewhere else, this is a single prompt with no gateway of its own, handed
  // to the primary window to send.
  if (satelliteSurface() === QUICK_ENTRY_SURFACE) {
    return <QuickEntryWindowRoot />
  }

  // The wake indicator (`?win=wake`) — a light over other applications saying
  // the phrase was heard (MJXHRM-228). The third satellite, and the one that is
  // not a surface to work in at all: it takes no input, no focus and no route,
  // and it is opened and closed by the state it mirrors rather than by the user.
  if (satelliteSurface() === WAKE_INDICATOR_SURFACE) {
    return <WakeIndicatorWindowRoot />
  }

  // A tile window (`?win=tile`, or the legacy `?win=secondary`) hosts exactly
  // ONE tile — a detached pane, or the single-chat pop-out — bypassing the full
  // shell/overlays entirely (MJX-104, generalized in MJXHRM-173).
  //
  // What is left is the phone: the desktop main window never gets here.
  return isTileWindow() ? <TileWindowRoot /> : <MobileController />
}

// Desktop's main.tsx does `import App from './app'`, where `./app` resolves to
// its src/app/index.tsx. Universal has a real src/app.tsx — this file, which
// picks the root per window — and a file wins over a sibling directory, so the
// same specifier lands here. The shadow is deliberate: it keeps main.tsx's import
// line desktop's, and desktop's root is named explicitly above as `@/app/index`.
export default App
