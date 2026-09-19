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
 * Two halves are wired. The REST door: every request desktop's API layer makes
 * funnels through `hermesApi` (`api/client.ts:117`) or calls
 * `window.hermesDesktop.api` directly, so that one binding turns on the whole
 * `@/hermes` surface. And the connection half (`./connections.ts`): what
 * desktop's gateway registry and boot hook resolve and dial through.
 *
 * The remaining namespaces (windows, git, terminal, updates, themes,
 * `connections`, …) are added as their units land. A member that is not
 * implemented stays ABSENT, never a silent fake: optional ones are
 * feature-detected by their callers, and the rest throw a TypeError naming
 * themselves.
 */

import { api } from '@/lib/api'

import { connectionBridge } from './connections'

/**
 * Desktop's `HermesApiRequest` and universal's `ApiRequest` agree field for
 * field — `path`, `method`, `body`, `upload`, `timeoutMs`, `profile`,
 * `connectionId` — and `HttpUpload` is structurally identical to desktop's
 * upload shape, so this is a straight pass-through onto the Rust
 * `http_request` command.
 *
 * `passive` is the one field with nowhere to go. It tells Electron's backend
 * pool not to cold-start a child for a background read (#103375). Universal has
 * no per-profile process pool — one gateway serves every profile and scopes by
 * `?profile=` — so there is nothing to avoid starting, and dropping it changes
 * no behaviour here.
 */
const apiBridge: NonNullable<typeof window.hermesDesktop>['api'] = request =>
  api({
    path: request.path,
    method: request.method,
    body: request.body,
    upload: request.upload,
    timeoutMs: request.timeoutMs,
    profile: request.profile,
    connectionId: request.connectionId ?? undefined
  })

export function installHermesDesktopBridge(): void {
  if (typeof window === 'undefined' || window.hermesDesktop) {
    return
  }

  // Deliberately a partial object cast to the full bridge type. The alternative
  // is stubbing 18 namespaces of methods nothing calls yet, which would hide
  // which parts are actually wired — a missing method throws a TypeError naming
  // itself, which is the loud failure we want while the shim is incomplete.
  window.hermesDesktop = {
    api: apiBridge,
    ...connectionBridge,
    // Optional-chained by its only caller; an Electron backend-pool keepalive
    // with no Tauri analogue.
    touchBackend: async () => undefined
  } as unknown as NonNullable<typeof window.hermesDesktop>
}
