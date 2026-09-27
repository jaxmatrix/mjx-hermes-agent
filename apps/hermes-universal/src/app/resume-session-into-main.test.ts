import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { SessionInfo } from '@/types/hermes'

const openSession = vi.fn()
const requestSessionResume = vi.fn()
const forgetSessionOwnerHintsForSession = vi.fn()
const sessionOwnerRouteFromRow = vi.fn()
const platform = vi.hoisted(() => ({ isMobile: false }))

vi.mock('@/app/open-session', () => ({
  openSession: (...args: unknown[]) => openSession(...args)
}))

vi.mock('@/store/session', () => ({
  forgetSessionOwnerHintsForSession: (...args: unknown[]) => forgetSessionOwnerHintsForSession(...args),
  requestSessionResume: (...args: unknown[]) => requestSessionResume(...args),
  sessionOwnerRouteFromRow: (...args: unknown[]) => sessionOwnerRouteFromRow(...args)
}))

const sessionRowFor = vi.fn()

vi.mock('@/store/session-lookup', () => ({
  sessionRowFor: (...args: unknown[]) => sessionRowFor(...args)
}))

vi.mock('@/lib/platform', () => ({
  get IS_MOBILE() {
    return platform.isMobile
  }
}))

import { resumeSessionIntoMain } from './resume-session-into-main'

describe('resumeSessionIntoMain', () => {
  const navigate = vi.fn()

  beforeEach(() => {
    platform.isMobile = false
    openSession.mockReset()
    requestSessionResume.mockReset()
    forgetSessionOwnerHintsForSession.mockReset()
    sessionOwnerRouteFromRow.mockReset()
    sessionRowFor.mockReset()
    sessionRowFor.mockReturnValue(null)
    navigate.mockReset()
  })

  it('requests resume with owner route when the row carries one', () => {
    const session = { id: 'stored-1' } as SessionInfo
    const owner = { connectionId: 'ssh-a', profile: 'default' }

    sessionOwnerRouteFromRow.mockReturnValue(owner)

    resumeSessionIntoMain('stored-1', navigate, session)

    expect(requestSessionResume).toHaveBeenCalledWith('stored-1', owner)
    expect(forgetSessionOwnerHintsForSession).not.toHaveBeenCalled()
    expect(openSession).toHaveBeenCalledWith('stored-1', navigate, 'in-place')
  })

  it('resolves the row from the store when only an id is passed', () => {
    const row = { id: 'stored-2', connection_id: 'ssh-a' } as SessionInfo
    const owner = { connectionId: 'ssh-a', profile: 'default' }

    sessionRowFor.mockReturnValue(row)
    sessionOwnerRouteFromRow.mockReturnValue(owner)

    resumeSessionIntoMain('stored-2', navigate)

    expect(sessionRowFor).toHaveBeenCalledWith('stored-2')
    expect(sessionOwnerRouteFromRow).toHaveBeenCalledWith(row)
    expect(requestSessionResume).toHaveBeenCalledWith('stored-2', owner)
  })

  it('clears stale owner hints and requests a bare resume when the row has no owner', () => {
    sessionOwnerRouteFromRow.mockReturnValue(undefined)

    resumeSessionIntoMain('stored-2', navigate)

    expect(forgetSessionOwnerHintsForSession).toHaveBeenCalledWith('stored-2')
    expect(requestSessionResume).toHaveBeenCalledWith('stored-2')
    expect(openSession).toHaveBeenCalledWith('stored-2', navigate, 'in-place')
  })

  it('uses main intent on phone so navigate always runs', () => {
    platform.isMobile = true
    sessionOwnerRouteFromRow.mockReturnValue(undefined)

    resumeSessionIntoMain('stored-3', navigate)

    expect(openSession).toHaveBeenCalledWith('stored-3', navigate, 'main')
  })

  it('no-ops on an empty id', () => {
    resumeSessionIntoMain('', navigate)

    expect(requestSessionResume).not.toHaveBeenCalled()
    expect(openSession).not.toHaveBeenCalled()
  })
})
