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
 * This is the first slice: the REST door, which is the hot path. Every request
 * desktop's API layer makes funnels through `hermesApi` (`api/client.ts:117`)
 * or calls `window.hermesDesktop.api` directly — 34 sites in total — so this
 * single binding turns on the whole `@/hermes` surface.
 *
 * The remaining 18 namespaces (windows, git, terminal, updates, themes, …) are
 * added as their units land. Installing a PARTIAL bridge is not free, though;
 * see the connection stubs below.
 */

import { api } from '@/lib/api'

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

/**
 * Why the connection methods are stubs that reject.
 *
 * `store/gateway.ts` is desktop's gateway REGISTRY, and it is byte-identical to
 * desktop's, so it cannot be edited. Its dial path guards on the bridge OBJECT
 * (`if (!desktop) return`, :549) and then calls `desktop.getConnection(...)`
 * UNGUARDED (:566). Today the object is absent, so the registry is inert and
 * requests reject cleanly with "Hermes gateway is not connected". Installing a
 * bridge without these would turn that clean rejection into a TypeError.
 *
 * They cannot do the real thing yet either. Universal already has a secondary-
 * socket manager — `store/gateway-secondaries.ts`, whose leases are bound to
 * Rust tunnels (`src-tauri/src/tunnels.rs`, MJXHRM-592) — and desktop's
 * registry is a second one that opens raw browser WebSockets Rust knows nothing
 * about. Running both means tunnel teardown orphaning the registry's sockets,
 * `MAX_SECONDARIES` bounding nothing, and every event arriving twice.
 * Reconciling them is its own unit; the registry has no socket-factory hook, so
 * there is no seam to do it through from here.
 *
 * So: reject, and reject in the one way the registry treats as PERMANENT.
 * `isMissingProfileError` (`store/gateway.ts:801`) matches "no longer exists",
 * which makes the registry fail-stop instead of entering its `scheduleReconnect`
 * ladder — preserving exactly today's behaviour. A generic message would be
 * classified as transient and retried forever.
 */
const REGISTRY_UNAVAILABLE =
  'The desktop gateway registry no longer exists in Hermes Universal — universal routes gateway ' +
  'sockets through its own tunnel-bound secondaries (store/gateway-secondaries.ts).'

const rejectRegistry = <T,>(): Promise<T> => Promise.reject(new Error(REGISTRY_UNAVAILABLE))

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
    getConnection: rejectRegistry,
    getConnectionFor: rejectRegistry,
    getGatewayWsUrlFor: rejectRegistry,
    // Optional-chained by its only caller; an Electron backend-pool keepalive
    // with no Tauri analogue.
    touchBackend: async () => undefined
  } as unknown as NonNullable<typeof window.hermesDesktop>
}
