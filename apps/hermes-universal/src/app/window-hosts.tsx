import { CloseConfirm } from '@/app/close-confirm'
import { AppContextMenu } from '@/app/context-menu/coordinator'
import { ExplorerPathDialog } from '@/app/explorer-path-dialog'
import { McpInstallDeepLinkDialog } from '@/app/mcp-install-deeplink-dialog'
import { RemoteFolderPicker } from '@/app/right-pane/files/remote-picker'
import { PluginInstallModal } from '@/app/settings/plugin-install-modal'
import { ConfirmHost } from '@/components/confirm-host'
import { FindBar } from '@/components/find-bar'
import { startMcpHealthChecker } from '@/store/mcp-health'

/**
 * The surfaces that must exist in every window whose root is UNIVERSAL's — the
 * phone shell, a tile window, the HUD, Quick Entry, the wake light and the
 * Android/iOS activity screen. `app.tsx` loads this as one chunk beside the
 * window's root, so none of those roots can forget a host, and the desktop main
 * window — whose `ContribWiring` mounts desktop's twin of each — never fetches
 * them (mounting both would draw the same question twice).
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
 * `CloseConfirm` (MJXHRM-390) is the third, and it was the same mistake one
 * level down: the "close a working chat?" gate mounted inside
 * `ContribController`, i.e. only in the DOCKED TILE TREE. A phone renders
 * `MobileShell` and a narrow window renders `AppShell`, so on both the gate
 * could park a pending close and nothing would ever draw the question — which
 * is why the mobile bubble strip dropped a chat mid-turn without asking.
 *
 * `ExplorerPathDialog` is the `CloseConfirm` shape again: "move this chat to
 * this folder, or only start new ones there?" is asked by a titlebar button, a
 * tree row's context menu and a search hit's kebab — three transient surfaces,
 * one of which Radix unmounts the instant it is selected. The asker cannot own
 * the dialog, so the window does.
 *
 * `ConfirmHost` (MJXHRM-479) is the strongest case of all: `confirm()` is
 * called from plain async handlers and store actions that have no component of
 * their own, so the promise is parked with NOTHING on screen unless a host is
 * mounted in that window. A settings panel, a command-center action and a
 * sidebar row each reach it from a different shell, so the shell level is again
 * one level too low.
 *
 * `AppContextMenu` (MJXHRM-478) is the sharpest case of the same rule: on Tauri
 * every engine pops its OWN context menu for a gesture the page does not
 * cancel, so a root without the coordinator does not merely lose the Hermes
 * menu — it shows WebKitGTK's "Reload / Inspect Element" over the app instead.
 * Right-click and long-press exist in every window.
 *
 * `McpInstallDeepLinkDialog` (MJXHRM-454) is the `ConfirmHost` case again from
 * outside the app: a `hermes://mcp/install` link is opened by the OS, so
 * whichever window happens to be listening has to be able to draw the
 * confirmation — and nothing is written to config until it is answered.
 * `PluginInstallModal` (MJXHRM-455) is its twin for `hermes://plugin/install`.
 *
 * Mounted HERE rather than once per root so the next root cannot forget them —
 * the failure mode is silence, which is the kind that ships.
 */
export function WindowHosts() {
  // Idempotent, and refuses in a satellite window, so the fleet gets ONE
  // sweeper. In the desktop main window `use-desktop-integrations` arms it.
  startMcpHealthChecker()

  return (
    <>
      <RemoteFolderPicker />
      <FindBar />
      <CloseConfirm />
      <ExplorerPathDialog />
      <ConfirmHost />
      <AppContextMenu />
      <McpInstallDeepLinkDialog />
      <PluginInstallModal />
    </>
  )
}
