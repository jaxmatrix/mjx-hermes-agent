/**
 * The rounds engine, driven entirely by `fakeRunner` — no gateway, no webview,
 * no clock. Every case here is one desktop learned in production.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MAIN_THREAD } from '../ids'
import type { RoomLine, RoomLog } from '../model/transcript'

import { createFakeRunner, type FakeRunner } from './fake-runner'
import { setRoomTurnRunner } from './registry'
import { type DriveEvent, type DriveMember, harvestStranded, plannedSpeakers, type RoomDriveDeps, runRoomDrive } from './rounds'
import { GROUP_CHAT_MAX_MESSAGES, GROUP_CHAT_MAX_ROUNDS, type PauseReason } from './types'

const memberOf = (profile: string): DriveMember => ({ profile, storedSessionId: `s-${profile}`, runtimeSessionId: `rt-${profile}` })

const line = (text: string, over: Partial<RoomLine> = {}): RoomLine => ({
  at: 100,
  from: { kind: 'user' },
  seq: 0,
  text,
  thread: MAIN_THREAD,
  ...over
})

interface Harness {
  deps: RoomDriveDeps
  events: DriveEvent[]
  runner: FakeRunner
  setLog(lines: RoomLine[]): void
  setEpoch(next: number): void
  setPaused(reason: null | PauseReason): void
  setWorking(profile: string, working: boolean): void
  watermarks: Map<string, number>
  harvests: string[]
  stagedFor: string[]
  keepAwakeHeld: () => boolean
}

function harness(profiles = ['radar', 'scout', 'owl']): Harness {
  const members = profiles.map(memberOf)
  const events: DriveEvent[] = []
  const runner = createFakeRunner()
  const stranded = new Map<string, { at: number; before: number; thread: string }>()
  const watermarks = new Map<string, number>()
  const harvests: string[] = []
  const stagedFor: string[] = []
  const working = new Set<string>()

  let lines: RoomLine[] = [line('@radar @scout what is the plan?')]
  let epoch = 1
  let paused: null | PauseReason = null
  let holds = 0

  const log = (): RoomLog => ({ cursors: {}, lines, rebuiltAt: 0 })

  const deps: RoomDriveDeps = {
    awaitResume: async () => undefined,
    buildPrompt: (member, delta) => `${member.profile}:${delta.map(l => l.text).join('|')}`,
    epoch: () => epoch,
    harvest: async member => {
      harvests.push(member.profile)

      return null
    },
    isWorking: member => working.has(member.profile),
    keepAwake: () => {
      holds += 1

      return () => {
        holds -= 1
      }
    },
    members,
    now: () => 1_000,
    paused: () => paused,
    readLog: async () => log(),
    report: event => events.push(event),
    roomId: 'r_aaa',
    roomName: 'Ops',
    stageRefs: async member => {
      stagedFor.push(member.profile)

      return []
    },
    stranded: {
      clear: member => void stranded.delete(member.profile),
      get: member => stranded.get(member.profile),
      set: (member, marker) => void stranded.set(member.profile, marker)
    },
    watermark: async member => watermarks.get(member.profile) ?? 0
  }

  return {
    deps,
    events,
    harvests,
    keepAwakeHeld: () => holds > 0,
    runner,
    setEpoch: next => {
      epoch = next
    },
    setLog: next => {
      lines = next
    },
    setPaused: reason => {
      paused = reason
    },
    setWorking: (profile, on) => void (on ? working.add(profile) : working.delete(profile)),
    stagedFor,
    watermarks
  }
}

let restore = () => {}

beforeEach(() => {
  restore = () => {}
})

afterEach(() => {
  restore()
})

const drive = async (h: Harness, thread = MAIN_THREAD, epoch = 1) => {
  restore = setRoomTurnRunner(h.runner)

  return runRoomDrive(h.deps, thread, epoch, new AbortController().signal)
}

describe('planning a round', () => {
  it('asks only the members the newest line addresses', () => {
    const members = ['radar', 'scout', 'owl'].map(memberOf)
    const log: RoomLog = { cursors: {}, lines: [line('@radar over to you')], rebuiltAt: 0 }

    expect(plannedSpeakers(log, MAIN_THREAD, members, 0).map(m => m.profile)).toEqual(['radar'])
  })

  it('rotates who goes first each round', () => {
    const members = ['radar', 'scout', 'owl'].map(memberOf)
    const log: RoomLog = { cursors: {}, lines: [line('everyone?')], rebuiltAt: 0 }

    expect(plannedSpeakers(log, MAIN_THREAD, members, 0).map(m => m.profile)).toEqual(['radar', 'scout', 'owl'])
    expect(plannedSpeakers(log, MAIN_THREAD, members, 1).map(m => m.profile)).toEqual(['scout', 'owl', 'radar'])
  })

  it('plans nothing for an empty thread', () => {
    expect(plannedSpeakers({ cursors: {}, lines: [], rebuiltAt: 0 }, MAIN_THREAD, [memberOf('radar')], 0)).toEqual([])
  })
})

describe('driving a room', () => {
  it('settles once every member passes', async () => {
    const h = harness()

    const result = await drive(h)

    expect(result.status).toBe('settled')
    expect(result.posted).toBe(0)
    // Only the two mentioned members were asked.
    expect(h.runner.plans.map(plan => plan.member.profile)).toEqual(['radar', 'scout'])
  })

  it('runs another round when someone actually spoke', async () => {
    const h = harness()

    h.runner.queue({ status: 'reply', text: 'here is the plan' })

    const result = await drive(h)

    expect(result.posted).toBe(1)
    // Round 0 asked radar + scout; round 1 asked them again (rotated) and both
    // passed, so the room settled rather than burning all three rounds.
    expect(h.events.filter(event => event.kind === 'round')).toHaveLength(2)
    expect(result.status).toBe('settled')
  })

  it('stops at GROUP_CHAT_MAX_ROUNDS even when the room keeps talking', async () => {
    const h = harness()

    h.runner.queue(...Array.from({ length: 20 }, () => ({ status: 'reply' as const, text: 'more' })))

    const result = await drive(h)

    expect(result.status).toBe('exhausted')
    expect(h.events.filter(event => event.kind === 'round')).toHaveLength(GROUP_CHAT_MAX_ROUNDS)
  })

  it('stops at GROUP_CHAT_MAX_MESSAGES', async () => {
    const h = harness(['a', 'b', 'c', 'd', 'e', 'f'])

    h.setLog([line('everyone speak')])
    h.runner.queue(...Array.from({ length: 30 }, () => ({ status: 'reply' as const, text: 'more' })))

    const result = await drive(h)

    expect(result.posted).toBe(GROUP_CHAT_MAX_MESSAGES)
    expect(result.status).toBe('exhausted')
  })

  it('bails the moment a newer user send bumps the epoch — at EVERY await point', async () => {
    const h = harness()

    // The user sends again while radar is thinking.
    h.runner.onTurn(() => h.setEpoch(2))

    const result = await drive(h)

    expect(result.status).toBe('superseded')
    // Exactly one member was asked: the loop re-checks before every turn, not
    // once at the top.
    expect(h.runner.plans).toHaveLength(1)
  })

  it('never submits into a member the gateway says is already working', async () => {
    const h = harness()

    h.setWorking('radar', true)

    await drive(h)

    expect(h.runner.plans.map(plan => plan.member.profile)).not.toContain('radar')
    expect(h.events).toContainEqual({ kind: 'outcome', member: 'radar', outcome: { status: 'busy' } })
  })

  it('treats a member timeout as a PASS, not a room error', async () => {
    const h = harness()

    h.runner.queue({ status: 'timeout', strandedBefore: 4 })

    const result = await drive(h)

    // scout still got its turn, and the room settled normally.
    expect(h.runner.plans.map(plan => plan.member.profile)).toEqual(['radar', 'scout'])
    expect(result.status).toBe('settled')
  })

  it('treats a member ERROR as a pass too', async () => {
    const h = harness()

    h.runner.queue({ message: 'transport died', status: 'error' })

    const result = await drive(h)

    expect(result.status).toBe('settled')
    expect(h.runner.plans).toHaveLength(2)
  })

  it('skips a member with nothing new to read', async () => {
    const h = harness()

    h.watermarks.set('radar', 9_999)

    await drive(h)

    expect(h.runner.plans.map(plan => plan.member.profile)).toEqual(['scout'])
  })

  it('stages the delta into the member BEFORE its prompt goes out', async () => {
    const h = harness()

    await drive(h)

    expect(h.stagedFor).toEqual(['radar', 'scout'])
  })

  it('holds the machine awake for the drive and releases it afterwards', async () => {
    const h = harness()

    h.runner.onTurn(() => {
      expect(h.keepAwakeHeld()).toBe(true)
    })

    await drive(h)

    expect(h.keepAwakeHeld()).toBe(false)
  })

  it('releases the hold even when the drive throws', async () => {
    const h = harness()

    h.runner.onTurn(() => {
      throw new Error('boom')
    })

    await expect(drive(h)).rejects.toThrow('boom')
    expect(h.keepAwakeHeld()).toBe(false)
  })
})

describe('pausing', () => {
  it('stops planning and REPORTS the reason instead of failing silently', async () => {
    const h = harness()

    h.setPaused('backgrounded')

    const result = await drive(h)

    expect(result).toEqual({ posted: 0, reason: 'backgrounded', status: 'paused' })
    expect(h.runner.plans).toEqual([])
  })

  it('does NOT cancel a member turn already in flight when the app backgrounds', async () => {
    const h = harness()

    // The pause arrives while radar is thinking. The gateway keeps running that
    // turn; throwing it away would discard work the user is waiting for.
    h.runner.onTurn(() => h.setPaused('backgrounded'))
    h.runner.queue({ status: 'reply', text: 'radar finished anyway' })

    const result = await drive(h)

    expect(h.runner.plans).toHaveLength(2)
    expect(result.posted).toBe(1)
    expect(result.status).toBe('paused')
  })

  it('pauses on a disconnect with its own reason', async () => {
    const h = harness()

    h.setPaused('disconnected')

    expect((await drive(h)).reason).toBe('disconnected')
  })
})

describe('the stranded harvest', () => {
  it('delivers a late reply BEFORE the round is planned against the log', async () => {
    const h = harness()

    h.deps.stranded.set(memberOf('radar'), { at: 1, before: 3, thread: MAIN_THREAD })

    // The late reply hands the conversation to owl. Harvesting AFTER the log is
    // read would plan the round against a log that is already stale, and owl
    // would never be asked.
    vi.spyOn(h.deps, 'harvest').mockImplementation(async () => {
      h.setLog([line('@radar what is the plan?'), line('@owl over to you', { at: 200, from: { kind: 'member', profile: 'radar' } })])

      return '@owl over to you'
    })

    await drive(h)

    expect(h.events[0]).toEqual({ kind: 'harvested', member: 'radar', text: '@owl over to you' })
    expect(h.runner.plans.map(plan => plan.member.profile)).toEqual(['owl'])
  })

  it('consumes a late (pass) without posting anything', async () => {
    const h = harness()

    h.deps.stranded.set(memberOf('radar'), { at: 1, before: 3, thread: MAIN_THREAD })

    // `harvest` answers null for a late pass.
    const stillRunning = await harvestStranded(h.deps)

    expect(stillRunning.size).toBe(0)
    expect(h.deps.stranded.get(memberOf('radar'))).toBeUndefined()
    expect(h.events).toEqual([])
  })

  it('consumes NOTHING from a member that is still running, and excludes it', async () => {
    const h = harness()

    h.deps.stranded.set(memberOf('radar'), { at: 1, before: 3, thread: MAIN_THREAD })
    h.setWorking('radar', true)

    const stillRunning = await harvestStranded(h.deps)

    expect(stillRunning.has('radar')).toBe(true)
    // The marker survives, so the reply is still collectable next time.
    expect(h.deps.stranded.get(memberOf('radar'))).toBeDefined()
    expect(h.harvests).toEqual([])
  })

  it('marks a timed-out member stranded with its message count, for next time', async () => {
    const h = harness()

    h.runner.queue({ status: 'timeout', strandedBefore: 7 })

    await drive(h)

    expect(h.deps.stranded.get(memberOf('radar'))).toMatchObject({ before: 7, thread: MAIN_THREAD })
  })
})

describe('two rooms sharing a member', () => {
  it('keeps the busy guard as the serialiser, not merely an optimisation', async () => {
    // The member is mid-turn in another room. Both rooms plan it; only the room
    // that got there first submits.
    const h = harness()

    h.setWorking('scout', true)

    await drive(h)

    expect(h.runner.plans.map(plan => plan.member.profile)).toEqual(['radar'])
    expect(h.deps.stranded.get(memberOf('scout'))).toBeDefined()
  })
})
