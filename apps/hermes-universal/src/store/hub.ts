import { getActionStatus, installSkillFromHub, uninstallSkillFromHub, updateSkillsFromHub } from '@/hermes'
import { map } from '@/store/atom'
import { notifyError } from '@/store/notifications'
import { refreshCapabilities } from '@/store/skills'

// Skill-hub install/uninstall/update actions. Each spawns a backend action, then
// polls its status to completion; on success the Skills list is refreshed so the
// hub and Skills tab stay in sync. The desktop per-profile epoch machinery is
// dropped (mobile is single-profile).
const POLL_MS = 1200
const MAX_POLLS = 150 // ~3 min cap so a stuck action can't poll forever.

export type HubActionKind = 'install' | 'uninstall' | 'update'
export const UPDATE_ALL_KEY = '__update_all__'

// Per-item running state (keyed by skill identifier/name, or UPDATE_ALL_KEY) so
// each row drives its own spinner without touching the others.
export const $hubActions = map<Record<string, { kind: HubActionKind; running: boolean } | undefined>>({})

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

async function runHubAction(key: string, kind: HubActionKind, spawn: () => Promise<{ name: string }>): Promise<boolean> {
  $hubActions.setKey(key, { kind, running: true })
  try {
    const started = await spawn()
    let exitCode: number | null = null
    for (let i = 0; i < MAX_POLLS; i += 1) {
      const status = await getActionStatus(started.name)
      if (!status.running) {
        exitCode = status.exit_code
        break
      }
      await delay(POLL_MS)
    }
    const ok = exitCode === 0 || exitCode === null
    if (ok) {
      await refreshCapabilities()
    }
    return ok
  } catch (err) {
    notifyError(err, 'Hub action failed')
    return false
  } finally {
    $hubActions.setKey(key, undefined)
  }
}

export const installFromHub = (identifier: string) =>
  runHubAction(identifier, 'install', () => installSkillFromHub(identifier))

export const uninstallFromHub = (name: string) => runHubAction(name, 'uninstall', () => uninstallSkillFromHub(name))

export const updateAllFromHub = () => runHubAction(UPDATE_ALL_KEY, 'update', () => updateSkillsFromHub())
