import { atom, map } from 'nanostores'

import { getActionStatus, installSkillFromHub, uninstallSkillFromHub, updateSkillsFromHub } from '@/hermes'
import { stripAnsi } from '@/lib/ansi'
import { queryClient } from '@/lib/query-client'
import { upsertDesktopActionTask } from '@/store/activity'
import { $activeGatewayProfile, normalizeProfileKey } from '@/store/profile'
import { $settingsScopeOverride } from '@/store/settings-scope'

const POLL_MS = 1200

// Shared with hub.tsx's sources useQuery so a finished action refreshes the
// installed map.
export const HUB_SOURCES_KEY = ['skill-hub-sources'] as const
// The Capabilities Skills-list query key (see app/skills/index.tsx) — kept in
// sync here so a hub (un)install updates the Skills tab, not just the hub.
const SKILLS_LIST_KEY = ['skills-list'] as const
// Non-identifier key for the fleet-wide "Update installed" action.
export const UPDATE_ALL_KEY = '__update_all__'

export type HubActionKind = 'install' | 'uninstall' | 'update'

export interface HubAction {
  kind: HubActionKind
  running: boolean
  lines: string[]
}

// Per-item action status, keyed by skill identifier (or UPDATE_ALL_KEY). Each
// row drives its own button off ITS entry — one install never touches another.
export const $hubActions = map<Record<string, HubAction | undefined>>({})

// Optimistic installed overrides so a row flips to its resolved state the instant
// its own action finishes, instead of waiting on (and racing) the sources
// refetch. install/update → true, uninstall → false; sources reconciles after.
export const $hubInstalledOverride = map<Record<string, boolean | undefined>>({})

// The key whose log the bottom pane currently tails (the latest-started action).
export const $hubActiveLog = atom<null | string>(null)

// Hub action state is per-profile: a profile switch must drop every in-flight
// entry, optimistic override, and active log so profile A's install/uninstall
// state can never render (or be polled) in profile B. Cleared at the source so
// it holds regardless of whether the Hub view is mounted. The epoch bumps on
// every switch; a runHubAction() started before the switch captures it and bails
// before any store write once it no longer matches (so an A action finishing
// after the clear can't repopulate B).
let _hubProfile: null | string = null
let _hubEpoch = 0

function clearHubState() {
  _hubEpoch += 1
  $hubActions.set({})
  $hubInstalledOverride.set({})
  $hubActiveLog.set(null)
}

$activeGatewayProfile.subscribe(value => {
  const key = normalizeProfileKey(value)

  if (_hubProfile !== null && _hubProfile !== key) {
    clearHubState()
  }

  _hubProfile = key
})

// The Capabilities scope override re-points installs at another profile, which
// is the same identity hazard as an app-wide switch: entries here are keyed by
// skill identifier alone, so profile A's running install would otherwise render
// as a spinner on profile B's row for the same skill (and its poll would write
// B's store). Same clear, same epoch.
let _hubScope = $settingsScopeOverride.get()

$settingsScopeOverride.subscribe(value => {
  if (value !== _hubScope) {
    _hubScope = value
    clearHubState()
  }
})

// One self-contained task: spawn → tail its own action log into the store →
// mark resolved. Concurrency-safe: state is per-key, so parallel installs never
// stomp each other, and the sources query is invalidated once at the end.
async function runHubAction(key: string, kind: HubActionKind, spawn: () => Promise<{ name: string }>): Promise<void> {
  const epoch = _hubEpoch
  const switched = () => _hubEpoch !== epoch

  $hubActions.setKey(key, { kind, running: true, lines: [] })
  $hubActiveLog.set(key)

  try {
    const started = await spawn()
    let exitCode: number | null = null

    for (;;) {
      const status = await getActionStatus(started.name, 200)

      // Profile switched mid-flight: the store was cleared for the new profile,
      // so drop this A-profile result instead of writing it back into B.
      if (switched()) {
        return
      }

      upsertDesktopActionTask(status)
      $hubActions.setKey(key, { kind, running: status.running, lines: status.lines })

      if (!status.running) {
        exitCode = status.exit_code

        break
      }

      await new Promise(resolve => setTimeout(resolve, POLL_MS))
    }

    // Only flip the row on a clean exit — a failed install/uninstall must not
    // render as installed/removed.
    if (key !== UPDATE_ALL_KEY && exitCode === 0) {
      $hubInstalledOverride.setKey(key, kind !== 'uninstall')
    }

    // A non-zero exit is a FAILED action, and it has to reach the user. The
    // spawned CLI reports the reason on its own stdout (unknown skill, network,
    // a policy block), so the last log line is the closest thing to a message;
    // throwing hands it to the caller's notifyError instead of leaving the
    // "Installing…" toast as the last thing anyone saw. The action log pane
    // starts collapsed, so without this the failure was invisible.
    if (exitCode !== 0) {
      const reason = ($hubActions.get()[key]?.lines ?? [])
        .map(line => stripAnsi(line).trim())
        .filter(Boolean)
        .at(-1)

      throw new Error(reason || `Skill ${kind} failed (exit ${exitCode ?? '?'})`)
    }

    // Refresh the hub's installed map AND the Capabilities Skills list — a hub
    // (un)install adds/removes a skill, so its count/rows must update too.
    void queryClient.invalidateQueries({ queryKey: HUB_SOURCES_KEY })
    void queryClient.invalidateQueries({ queryKey: SKILLS_LIST_KEY })
  } catch (err) {
    // A profile switch points the next poll at the new backend, which 404s the
    // old action name — that's an abandonment, not a failure, so swallow it
    // instead of letting the caller toast a phantom error. Real (same-profile)
    // failures still propagate.
    if (switched()) {
      return
    }

    throw err
  } finally {
    // Skip the running=false write after a switch — it would re-add the key the
    // profile-switch clear just dropped.
    const current = $hubActions.get()[key]

    if (current && !switched()) {
      $hubActions.setKey(key, { ...current, running: false })
    }
  }
}

// `profile` is the Capabilities scope the VIEW is showing — the install has to
// land in that profile, not in whichever one the app happens to be on. `null`/
// omitted keeps the pre-existing shape (the app-wide active profile).
export function installHubSkill(identifier: string, profile?: null | string): Promise<void> {
  return runHubAction(identifier, 'install', () => installSkillFromHub(identifier, profile))
}

export function uninstallHubSkill(identifier: string, name: string, profile?: null | string): Promise<void> {
  return runHubAction(identifier, 'uninstall', () => uninstallSkillFromHub(name, profile))
}

export function updateHubSkills(profile?: null | string): Promise<void> {
  return runHubAction(UPDATE_ALL_KEY, 'update', () => updateSkillsFromHub(profile))
}

export function closeHubLog(): void {
  $hubActiveLog.set(null)
}
