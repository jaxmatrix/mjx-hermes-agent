import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { WritableAtom } from '@/store/atom'

import type * as SessionStateTypes from './session-state-types'
import type * as TranscriptCacheSync from './transcript-cache-sync'
import { SessionWakeError } from './transcript-cache-sync'

const awaitSessionPainted = vi.fn()
const openSession = vi.fn()
const focusOpenSession = vi.fn()
const selectProfile = vi.fn()
const knownSessionProfile = vi.fn<(id: string) => string | undefined>()
const resolveSessionProfile = vi.fn<() => Promise<string | undefined>>()

vi.mock('./transcript-cache-sync', async importOriginal => {
  const actual = await importOriginal<typeof TranscriptCacheSync>()

  return { ...actual, awaitSessionPainted: (...args: unknown[]) => awaitSessionPainted(...args) }
})

vi.mock('./session', () => ({
  knownSessionProfile: (id: string) => knownSessionProfile(id),
  openSession: (id: string) => openSession(id),
  resolveSessionProfile: () => resolveSessionProfile()
}))

vi.mock('./session-states', () => ({ focusOpenSession: (id: string) => focusOpenSession(id) }))

// PARTIAL, deliberately: `transcript-cache-sync` subscribes to `$sessionStates`
// at module scope and other modules read `$activeSessionKey` from here, so a
// wholesale mock would silently remove them (recipe 6.4's trap).
vi.mock('./session-state-types', async importOriginal => ({
  ...(await importOriginal<typeof SessionStateTypes>()),
  runtimeKeyForStoredSession: () => 'runtime-1'
}))

const profile = vi.hoisted(() => ({ active: 'default' }))

vi.mock('./profile', async () => {
  const { atom } = await import('@/store/atom')
  const $activeGatewayProfile = atom(profile.active)

  return {
    $activeGatewayProfile,
    normalizeProfileKey: (name?: null | string) => (name ?? '').trim() || 'default',
    selectProfile: (name: string) => {
      selectProfile(name)
      $activeGatewayProfile.set(name)
    }
  }
})

vi.mock('./connection-ready', async () => {
  const { atom } = await import('@/store/atom')

  return { $connectionReady: atom(true) }
})

import { $connectionReady } from './connection-ready'
import { $resumeExhaustedSessionId, openPluginSession } from './plugin-open-session'
import { $activeGatewayProfile } from './profile'

// Both are writable ATOMS under the mocks above; the real modules publish them
// as readonly views, so the cast is the test's own, not a hole in the contract.
const READY = $connectionReady as WritableAtom<boolean>
const ACTIVE_PROFILE = $activeGatewayProfile as unknown as WritableAtom<string>

beforeEach(() => {
  READY.set(true)
  ACTIVE_PROFILE.set('default')
  $resumeExhaustedSessionId.set(null)
  awaitSessionPainted.mockReset().mockResolvedValue(undefined)
  openSession.mockReset()
  focusOpenSession.mockReset()
  selectProfile.mockReset()
  knownSessionProfile.mockReset().mockReturnValue(undefined)
  resolveSessionProfile.mockReset().mockResolvedValue(undefined)
})

describe('openPluginSession', () => {
  it('opens, waits for PAINT, and focuses', async () => {
    const result = await openPluginSession('s1')

    expect(openSession).toHaveBeenCalledWith('s1')
    // The transcript, not the request: `expectHistory` is what makes the wake
    // complete on pixels rather than on a runtime binding.
    expect(awaitSessionPainted).toHaveBeenCalledWith('s1', expect.objectContaining({ expectHistory: true }))
    expect(focusOpenSession).toHaveBeenCalledWith('s1')
    expect(result).toMatchObject({ ok: true })
  })

  // A compaction can rotate the stored id while the resume is in flight, so the
  // answer is read off the slice rather than echoed back.
  it('reads the canonical id back off the session slice', async () => {
    const { publishSessionState, emptySessionState } = await import('./session-state-types')
    publishSessionState('runtime-1', { ...emptySessionState('rotated-by-compaction') })

    await expect(openPluginSession('s1')).resolves.toMatchObject({ storedSessionId: 'rotated-by-compaction' })
  })

  it('leaves focus alone when the caller said not to', async () => {
    await openPluginSession('s1', { focus: false })

    expect(focusOpenSession).not.toHaveBeenCalled()
  })

  it('refuses before touching the session when the app is not usable', async () => {
    READY.set(false)

    await expect(openPluginSession('s1')).resolves.toEqual({ error: 'no-gateway', ok: false })
    expect(openSession).not.toHaveBeenCalled()
  })

  it('switches profile FIRST, or the session resolves its cwd under the outgoing one', async () => {
    knownSessionProfile.mockReturnValue('work')

    await openPluginSession('s1')

    expect(selectProfile).toHaveBeenCalledWith('work')
    expect(selectProfile.mock.invocationCallOrder[0]).toBeLessThan(openSession.mock.invocationCallOrder[0])
  })

  it('does not switch when the session already belongs to the active profile', async () => {
    knownSessionProfile.mockReturnValue('default')

    await openPluginSession('s1')

    expect(selectProfile).not.toHaveBeenCalled()
  })

  it('falls back to the probe when the owner is not already known', async () => {
    resolveSessionProfile.mockResolvedValue('work')

    await openPluginSession('s1')

    expect(selectProfile).toHaveBeenCalledWith('work')
  })

  // The user moved on. Nothing is wrong, and a caller must be able to tell this
  // from a failure — it is not something to toast.
  it('reports a superseded wake as its own outcome', async () => {
    awaitSessionPainted.mockRejectedValue(new SessionWakeError('superseded', 'activation'))

    await expect(openPluginSession('s1')).resolves.toEqual({ error: 'superseded', ok: false })
    expect($resumeExhaustedSessionId.get()).toBeNull()
  })

  it('retries a HYDRATION timeout exactly once, then reports exhausted', async () => {
    awaitSessionPainted.mockRejectedValue(new SessionWakeError('timeout', 'hydration'))

    const result = await openPluginSession('s1')

    expect(awaitSessionPainted).toHaveBeenCalledTimes(2)
    expect(result).toEqual({ error: 'exhausted', exhausted: true, ok: false })
    expect($resumeExhaustedSessionId.get()).toBe('s1')
  })

  it('succeeds on the retry when the second wake lands', async () => {
    awaitSessionPainted
      .mockRejectedValueOnce(new SessionWakeError('timeout', 'hydration'))
      .mockResolvedValueOnce(undefined)

    await expect(openPluginSession('s1')).resolves.toMatchObject({ ok: true })
    expect($resumeExhaustedSessionId.get()).toBeNull()
  })

  // An ACTIVATION that never bound is a wedged dial; a second wait costs the
  // caller another 20 s and cannot help.
  it('does NOT retry an activation timeout', async () => {
    awaitSessionPainted.mockRejectedValue(new SessionWakeError('timeout', 'activation'))

    await expect(openPluginSession('s1')).resolves.toMatchObject({ error: 'exhausted' })
    expect(awaitSessionPainted).toHaveBeenCalledOnce()
  })

  it('clears a previous exhaustion once an open succeeds', async () => {
    $resumeExhaustedSessionId.set('s1')

    await openPluginSession('s1')

    expect($resumeExhaustedSessionId.get()).toBeNull()
  })
})
