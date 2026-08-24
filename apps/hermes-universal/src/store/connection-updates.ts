import { invoke } from '@tauri-apps/api/core'

import { updateHermes } from '@/hermes'
import { IS_TAURI } from '@/lib/platform'
import { openAppDownload } from '@/lib/updates'
import { $activeConnection } from '@/store/active-connection'
import { $connectionsRegistry } from '@/store/connections'
import { runUpdateCheck } from '@/store/updates'

/**
 * "UPDATE EVERYTHING" — active backend, then the other sources, then the client.
 *
 * The ORDER is the policy and it lives here; the fan-out itself is Rust's
 * (`connections_update_all`), because each row needs that source's credential
 * and Rust already holds them.
 *
 * The client is LAST because applying it relaunches or hands off the app — a
 * fan-out queued behind it would simply never run.
 *
 * Every step reports a ROW, never a silence. A backend that is docker/nix/
 * externally managed answers `ok:false` with its own reason and gets skipped
 * with THAT message; an unreachable source fails its own row and nothing else;
 * and when the off-by-default `update-checks` feature is compiled out, the
 * client step says `checks-disabled` rather than quietly doing nothing.
 */

export interface UpdateTargetResult {
  connectionId: string
  label: string
  ok: boolean
  skipped: boolean
  reason?: string
  detail?: string
}

export interface UpdateAllOptions {
  /** Sources to leave alone (the active one is always excluded — step 1 has it). */
  excludeIds?: string[]
}

/**
 * Whether the "Update everything" affordance is worth showing.
 *
 * Single-source users keep the one-button experience: with one connection there
 * is nothing to fan out to, so the button is ABSENT rather than a synonym for
 * the button beside it.
 */
export function hasMultipleUpdateTargets(): boolean {
  return $connectionsRegistry.get().connections.length > 1
}

async function updateActive(): Promise<UpdateTargetResult> {
  const active = $activeConnection.get()

  const row: UpdateTargetResult = {
    connectionId: active?.connectionId ?? '',
    label: active?.label ?? '',
    ok: false,
    skipped: false
  }

  if (!active) {
    return { ...row, reason: 'not-connected', skipped: true }
  }

  try {
    const response = await updateHermes()
    // The backend's own refusal (docker / nix / externally managed) is a SKIP
    // with its own reason, not a failure of the batch. `ActionResponse` carries
    // only `ok`, so the detail comes from the action's status stream, which the
    // Command Center already surfaces — this row's job is to say WHICH targets
    // were reached.
    const ok = response.ok !== false

    return { ...row, ok, reason: ok ? undefined : 'backend-refused', skipped: !ok }
  } catch (error) {
    // `.catch`, deliberately: one unreachable backend must not strand the rest.
    return { ...row, detail: error instanceof Error ? error.message : String(error), reason: 'unreachable' }
  }
}

async function updateClient(): Promise<UpdateTargetResult> {
  const row: UpdateTargetResult = { connectionId: 'client', label: 'Hermes', ok: false, skipped: true }

  if (!IS_TAURI) {
    return { ...row, reason: 'checks-disabled' }
  }

  const status = await runUpdateCheck(true)

  if (!status) {
    // The `update-checks` feature is off, or the command is unavailable. A ROW,
    // not a silence.
    return { ...row, reason: 'checks-disabled' }
  }

  if (!status.updateAvailable || !status.downloadUrl) {
    return { ...row, ok: true, reason: status.reason ?? 'up-to-date' }
  }

  try {
    // Opens the release asset / store listing. There is no self-install on any
    // platform, which is exactly why this is safe to run last.
    await openAppDownload(status.downloadUrl, status.notesUrl)

    return { ...row, ok: true, skipped: false }
  } catch (error) {
    return {
      ...row,
      detail: error instanceof Error ? error.message : String(error),
      reason: 'download-failed',
      skipped: false
    }
  }
}

export async function updateAllTargets(options: UpdateAllOptions = {}): Promise<UpdateTargetResult[]> {
  const active = $activeConnection.get()
  const excludeIds = [...(options.excludeIds ?? []), ...(active ? [active.connectionId] : [])]

  const first = await updateActive()

  const others = IS_TAURI
    ? await invoke<UpdateTargetResult[]>('connections_update_all', { excludeIds }).catch(
        () => [] as UpdateTargetResult[]
      )
    : []

  return [first, ...others, await updateClient()]
}
