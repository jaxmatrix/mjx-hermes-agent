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
 * Three parts are wired in full. The REST door: every request desktop's API layer makes
 * funnels through `hermesApi` (`api/client.ts:117`) or calls
 * `window.hermesDesktop.api` directly, so that one binding turns on the whole
 * `@/hermes` surface. The connection half (`./connections.ts`): what
 * desktop's gateway registry and boot hook resolve and dial through. And the
 * OS clipboard (`lib/clipboard-tauri.ts`), which desktop's copy paths detect.
 * Two smaller ones ride along: the wake light (`./wake-indicator.ts`) and
 * `readWindowBelow`, the one bridge member desktop's server-request fold calls.
 *
 * The remaining namespaces (windows, git, terminal, updates, themes,
 * `connections`, …) are added as their units land. A member that is not
 * implemented stays ABSENT, never a silent fake: optional ones are
 * feature-detected by their callers, and the rest throw a TypeError naming
 * themselves.
 */

import { api } from '@/lib/api'
import { createClipboardBridge } from '@/lib/clipboard-tauri'
import { IS_DESKTOP, IS_TAURI } from '@/lib/platform'
import { readWindowBelow } from '@/lib/surface'

import { connectionBridge, restScope } from './connections'
import { wakeIndicatorBridge } from './wake-indicator'
import { installWindowControlsOverlay } from './window-chrome'

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
    // Optional-chained by its only caller; an Electron backend-pool keepalive
    // with no Tauri analogue.
    touchBackend: async () => undefined
  } as unknown as NonNullable<typeof window.hermesDesktop>
}
