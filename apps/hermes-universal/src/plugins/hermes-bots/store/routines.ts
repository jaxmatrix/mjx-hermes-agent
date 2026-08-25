/**
 * Routines — cron, scoped to ONE bot.
 *
 * The load-bearing rule is the CAPTURED OWNER: a routine belongs to the agent
 * it was created for, not to whatever agent happens to be selected when a later
 * call goes out. Every mutating cron call carries that profile explicitly
 * (MJXHRM-457 fixed all eight of them for the same reason), so switching the
 * BOTS selection while a routine list is open cannot pause someone else's job.
 *
 * `cron.changed` is already a global gateway event, so the 20 s poll desktop ran
 * is deleted: the tick refreshes, and the backstop is only there for a gateway
 * that does not broadcast.
 */

import { atom, livePollIntervalMs } from '@hermes/plugin-sdk'

import type { RosterRow } from '../model/roster'

import { type AgentRoute, createRoutine, type CronRow, listRoutines, setRoutineState } from './rpc'

export const routinesIntervalMs = (): number => livePollIntervalMs(20_000, 120_000)

export const $routines = atom<readonly CronRow[]>([])
export const $routinesOwner = atom<null | string>(null)
export const $routinesError = atom<null | string>(null)

const routeOf = (row: RosterRow): AgentRoute => ({
  ...(row.connectionId ? { connectionId: row.connectionId } : {}),
  profile: row.profile
})

/**
 * Load one bot's routines.
 *
 * The owner is stamped alongside the rows so a late answer for a bot the user
 * has since switched away from cannot paint into the new bot's list.
 */
export async function loadRoutines(row: RosterRow): Promise<void> {
  const owner = row.key

  $routinesOwner.set(owner)

  try {
    const result = await listRoutines(routeOf(row))

    if ($routinesOwner.get() !== owner) {
      return
    }

    $routines.set(result.jobs ?? [])
    $routinesError.set(null)
  } catch (error) {
    if ($routinesOwner.get() === owner) {
      $routines.set([])
      $routinesError.set(error instanceof Error ? error.message : String(error))
    }
  }
}

/** The owner is CAPTURED at call time, never read from the selection. */
export async function addRoutine(
  row: RosterRow,
  params: { name: string; prompt: string; schedule: string }
): Promise<void> {
  await createRoutine(params, routeOf(row))
  await loadRoutines(row)
}

export async function updateRoutine(
  row: RosterRow,
  jobId: string,
  action: 'pause' | 'remove' | 'resume'
): Promise<void> {
  await setRoutineState(jobId, action, routeOf(row))
  await loadRoutines(row)
}
