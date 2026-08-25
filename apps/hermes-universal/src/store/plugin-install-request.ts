import { gatewayRpcErrorCode } from '@/gateway/rpc-error'
import type { PluginInstallLegacyHint } from '@/lib/deep-link-routes'
import { installAgentPlugin, type PluginInstallResult } from '@/lib/gateway-rpc'
import { atom } from '@/store/atom'

/**
 * The pending "install this plugin?" question, and the one call that answers it.
 *
 * ONE install path, deliberately: the gateway clones into
 * `<HERMES_HOME>/plugins/<name>/`, and its desktop half — if the package has one
 * — lands at `plugins/<name>/desktop/plugin.js`, which is exactly the second
 * disk root `contrib/plugin-disk.ts` now reads. So there is nothing for a
 * client-side git clone to do, and it could not exist on Android or iOS anyway,
 * where the REST door is the only door.
 *
 * The RPC lives HERE rather than in the dialog's render (`installPluginRequest`)
 * so that if a second destination is ever wanted — a local `desktop-plugins`
 * clone behind a new Rust command — it is one function to widen, not a dialog to
 * unpick. Until something asks for it, one path stays one path.
 */

/** Where the request came from. "A web page asked for this" and "you clicked
 *  Install" are the same act with very different weight, and the dialog says so
 *  — including by NOT focusing its Install button for a link. */
export type PluginInstallOrigin = 'deep-link' | 'settings'

export interface PluginInstallRequest {
  /** `owner/repo`, `owner/repo/subdir`, or a full git URL. */
  repo: string
  enable?: boolean
  force?: boolean
  /** Which component a legacy `plugin-agent`/`plugin-desktop` link named. Shown
   *  as provenance; there is only one install path to select. */
  legacyHint?: PluginInstallLegacyHint
  /** Whose HERMES_HOME receives it. Null = the app's active profile, which is
   *  what `installAgentPlugin`'s own scoping already sends. */
  profile?: null | string
  origin: PluginInstallOrigin
}

/**
 * Why an install did not happen. Each maps to a different thing to DO, which is
 * the only reason to distinguish them:
 *  • `no-identifier` (4019) — nothing to retry; the link was malformed.
 *  • `already-exists` (5026) — retry with Force, which is one switch away.
 *  • `unknown-action` (4017) — unreachable by construction; a bug worth showing.
 *  • `unreachable` — the gateway never answered. The clone may STILL BE RUNNING,
 *    so this must not be reported as a failure: a false failure invites a Force
 *    retry, and Force is what deletes a good install.
 */
export type PluginInstallFailure = 'already-exists' | 'no-identifier' | 'unknown-action' | 'unreachable'

export type PluginInstallOutcome =
  | { ok: false; failure: PluginInstallFailure; message: string }
  | { ok: true; result: PluginInstallResult }

const ERROR_CODES: Record<number, PluginInstallFailure> = {
  4017: 'unknown-action',
  4019: 'no-identifier',
  5026: 'already-exists'
}

export const $pluginInstallRequest = atom<null | PluginInstallRequest>(null)

/** Open the consent dialog. One request at a time; a second supersedes the
 *  first, the same rule `store/confirm.ts` runs on. */
export function openPluginInstallRequest(request: PluginInstallRequest): void {
  $pluginInstallRequest.set(request)
}

export function closePluginInstallRequest(): void {
  $pluginInstallRequest.set(null)
}

/**
 * Ask the gateway to install. Never throws — every outcome is shaped, because
 * the dialog has to render four visibly different things.
 *
 * NO CLIENT TIMEOUT (`timeoutMs: 0`). A git clone can legitimately take minutes
 * and the gateway owns the deadline; a client-side one would turn a slow-but-fine
 * install into an `unreachable` the user is invited to Force over.
 */
export async function installPluginRequest(request: PluginInstallRequest): Promise<PluginInstallOutcome> {
  try {
    const result = await installAgentPlugin(
      {
        enable: request.enable,
        force: request.force,
        identifier: request.repo,
        profile: request.profile
      },
      0
    )

    return { ok: true, result }
  } catch (error) {
    const code = gatewayRpcErrorCode(error)
    const message = error instanceof Error ? error.message : String(error)

    // A null code means the rejection never came off the wire as a JSON-RPC
    // error — a timeout, a dropped socket, a local throw. The gateway may be
    // cloning right now, so this is explicitly NOT "install failed".
    return { failure: (code !== null && ERROR_CODES[code]) || 'unreachable', message, ok: false }
  }
}
