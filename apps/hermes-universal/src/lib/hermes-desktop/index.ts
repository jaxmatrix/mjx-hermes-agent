/**
 * The `window.hermesDesktop` bridge, implemented over Tauri.
 *
 * Desktop's renderer never imports `electron`. Everything it needs from the
 * main process arrives through this one global, published by
 * `apps/desktop/electron/preload.ts` and typed in `src/global.ts`. Universal
 * has no preload, so the same global has to be installed here — and doing that
 * rather than editing the ported call sites is what keeps `src/api/*`,
 * `src/hermes.ts` and `src/store/gateway.ts` byte-identical to desktop, so a
 * resync never has to merge them.
 *
 * Three parts came first. The REST door: every request desktop's API layer makes
 * funnels through `hermesApi` (`api/client.ts:117`) or calls
 * `window.hermesDesktop.api` directly, so that one binding turns on the whole
 * `@/hermes` surface. The connection half (`./connections.ts`): what
 * desktop's gateway registry and boot hook resolve and dial through. And the
 * OS clipboard (`lib/clipboard-tauri.ts`), which desktop's copy paths detect.
 * Two smaller ones ride along: the wake light (`./wake-indicator.ts`) and
 * `readWindowBelow`, the one bridge member desktop's server-request fold calls.
 *
 * Then the everyday members, one file per concern, each a thin delegation onto
 * a Rust command or a universal lib that already existed: what leaves for the
 * OS (`./external.ts`), the OS pickers (`./dialogs.ts`), local files as data
 * URLs (`./files.ts`), Save image (`./images.ts`), OS notifications
 * (`./notifications.ts`), text size (`./zoom.ts`), keep-awake (`./power.ts`)
 * and window glass (`./translucency.ts`).
 *
 * The remaining namespaces (windows, git, terminal, updates, themes,
 * `connections`, …) are added as their units land. `./preload-drift.test.ts`
 * holds the list: every member of Electron's preload is either implemented
 * here or named there with the reason it is not. A member that is not
 * implemented stays ABSENT, never a silent fake: optional ones are
 * feature-detected by their callers, and the rest throw a TypeError naming
 * themselves.
 */

import { api } from '@/lib/api'
import { createClipboardBridge } from '@/lib/clipboard-tauri'
import { IS_DESKTOP, IS_TAURI } from '@/lib/platform'
import { readWindowBelow } from '@/lib/surface'

import { connectionBridge, restScope } from './connections'
import { dialogsBridge } from './dialogs'
import { externalBridge, revealBridge } from './external'
import { filesBridge } from './files'
import { imagesBridge } from './images'
import { notificationsBridge } from './notifications'
import { powerBridge } from './power'
import { translucencyBridge } from './translucency'
import { wakeIndicatorBridge } from './wake-indicator'
import { hostsWindowChrome, installWindowControlsOverlay } from './window-chrome'
import { restoreZoom, zoomBridge } from './zoom'

/**
 * Desktop's `HermesApiRequest` and universal's `ApiRequest` agree field for
 * field — `path`, `method`, `body`, `upload`, `timeoutMs`, `profile`,
 * `connectionId` — and `HttpUpload` is structurally identical to desktop's
 * upload shape, so this is a straight pass-through onto the Rust
 * `http_request` command. Only `connectionId` is translated (`restScope`).
 *
 * `passive` is the one field with nowhere to go. It tells Electron's backend
 * pool not to cold-start a child for a background read (#103375). Universal has
 * no per-profile process pool — one gateway serves every profile and scopes by
 * `?profile=` — so there is nothing to avoid starting, and dropping it changes
 * no behaviour here.
 */
const apiBridge: NonNullable<typeof window.hermesDesktop>['api'] = async request => {
  const scope = await restScope(request.connectionId)

  try {
    return await api({
      path: request.path,
      method: request.method,
      body: request.body,
      upload: request.upload,
      timeoutMs: request.timeoutMs,
      profile: request.profile,
      connectionId: scope.connectionId
    })
  } finally {
    scope.release()
  }
}

export function installHermesDesktopBridge(): void {
  if (typeof window === 'undefined' || window.hermesDesktop) {
    return
  }

  // Not a bridge member, but the same kind of thing: what Electron's frame
  // tells the renderer about the OS buttons, before any connection exists.
  installWindowControlsOverlay()

  // Electron restores a window's text size before its renderer runs. Desktop's
  // root only: a HUD or a wake light is not a page of text.
  if (hostsWindowChrome()) {
    restoreZoom()
  }

  // Deliberately a partial object cast to the full bridge type. The alternative
  // is stubbing 18 namespaces of methods nothing calls yet, which would hide
  // which parts are actually wired — a missing method throws a TypeError naming
  // itself, which is the loud failure we want while the shim is incomplete.
  window.hermesDesktop = {
    api: apiBridge,
    ...connectionBridge,
    // The OS clipboard. Desktop's `installClipboardShim` and `writeClipboardText`
    // feature-detect `writeClipboard`; without it every copy falls back to the
    // web API, which WebKitGTK drops (see `lib/clipboard-tauri.ts`).
    ...createClipboardBridge(),
    // `window.read` (the read_window_below tool): desktop's fold answers it from
    // this one optional member, and answers "unavailable" without it. Rust reads
    // the window stack (`surface/below.rs`); its refusals go back VERBATIM — an
    // `{ error }` tells the model the window could not be read, where an empty
    // answer would tell it the screen is empty. No window stack on a phone.
    ...(IS_DESKTOP && { readWindowBelow }),
    // The wake light. A whole namespace or none — see `./wake-indicator`.
    ...(IS_TAURI && { wakeIndicator: wakeIndicatorBridge }),
    // Everything below is a Rust command or a Tauri plugin, so without a runtime
    // (plain-browser dev) it is absent rather than a member that always rejects.
    ...(IS_TAURI && {
      ...dialogsBridge,
      ...externalBridge,
      ...filesBridge,
      ...imagesBridge,
      ...notificationsBridge,
      // The mobile pre-flight; desktop webviews ask on `getUserMedia` themselves.
      requestMicrophoneAccess: async () => (await import('@/lib/mic-permission')).ensureMicPermission(),
      zoom: zoomBridge
    }),
    // No file manager, sleep inhibitor or window manager on a phone.
    ...(IS_DESKTOP && { ...revealBridge, ...powerBridge }),
    ...translucencyBridge(),
    // Optional-chained by its only caller; an Electron backend-pool keepalive
    // with no Tauri analogue.
    touchBackend: async () => undefined
  } as unknown as NonNullable<typeof window.hermesDesktop>
}
