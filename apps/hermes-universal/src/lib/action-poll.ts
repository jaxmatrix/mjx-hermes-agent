import { getActionStatus } from '@/hermes'

// Shared "spawn a backend action, poll its status to completion" helper — the
// gateway runs ops (doctor/backup/curator/restart/update) as background actions
// that must be polled via getActionStatus. Returns success + the captured log
// lines. Bounded so a stuck action can't poll forever.
const POLL_MS = 1200
const MAX_POLLS = 150 // ~3 min

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

export async function runAction(spawn: () => Promise<{ name: string }>): Promise<{ ok: boolean; lines: string[] }> {
  const started = await spawn()
  for (let i = 0; i < MAX_POLLS; i += 1) {
    const status = await getActionStatus(started.name)
    if (!status.running) {
      return { ok: status.exit_code === 0 || status.exit_code === null, lines: status.lines }
    }
    await delay(POLL_MS)
  }
  return { ok: false, lines: [] }
}
