import { renderHook } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const resumeSessionIntoMain = vi.fn()
const lastOpenedSessionId = vi.fn(() => null as null | string)

const { gatewayState, hasConnected, activeStoredSessionId } = vi.hoisted(() => {
  const mockAtom = <T,>(initial: T) => {
    let value = initial
    const listeners = new Set<(next: T) => void>()

    return {
      get: () => value,
      set: (next: T) => {
        value = next

        for (const listener of listeners) {
          listener(next)
        }
      },
      subscribe: (listener: (next: T) => void) => {
        listeners.add(listener)
        listener(value)

        return () => {
          listeners.delete(listener)
        }
      }
    }
  }

  return {
    activeStoredSessionId: mockAtom<null | string>(null),
    gatewayState: mockAtom('closed'),
    hasConnected: mockAtom(false)
  }
})

vi.mock('@/app/resume-session-into-main', () => ({
  resumeSessionIntoMain: (...args: unknown[]) => resumeSessionIntoMain(...args)
}))

vi.mock('@/store/session', async importOriginal => {
  const actual = await importOriginal<typeof import('@/store/session')>()

  return {
    ...actual,
    $gatewayState: gatewayState
  }
})

vi.mock('@/store/connection', async importOriginal => {
  const actual = await importOriginal<typeof import('@/store/connection')>()

  return {
    ...actual,
    $hasConnected: hasConnected
  }
})

vi.mock('@/store/session-lifecycle', async importOriginal => {
  const actual = await importOriginal<typeof import('@/store/session-lifecycle')>()

  return {
    ...actual,
    $activeStoredSessionId: activeStoredSessionId,
    lastOpenedSessionId: () => lastOpenedSessionId()
  }
})

import { useRestoreLastSession } from './use-restore-last-session'

function renderRestore(initialPath = '/') {
  return renderHook(() => useRestoreLastSession(), {
    wrapper: ({ children }) => <MemoryRouter initialEntries={[initialPath]}>{children}</MemoryRouter>
  })
}

describe('useRestoreLastSession', () => {
  beforeEach(() => {
    resumeSessionIntoMain.mockReset()
    lastOpenedSessionId.mockReset().mockReturnValue(null)
    gatewayState.set('closed')
    hasConnected.set(false)
    activeStoredSessionId.set(null)
  })

  afterEach(() => {
    gatewayState.set('closed')
    hasConnected.set(false)
    activeStoredSessionId.set(null)
  })

  it('does not restore until the gateway is open and hasConnected', () => {
    lastOpenedSessionId.mockReturnValue('remembered-1')
    renderRestore('/')

    expect(resumeSessionIntoMain).not.toHaveBeenCalled()

    hasConnected.set(true)
    expect(resumeSessionIntoMain).not.toHaveBeenCalled()

    gatewayState.set('open')
    expect(resumeSessionIntoMain).toHaveBeenCalledWith('remembered-1', expect.any(Function))
  })

  it('does not call lifecycle hydrate — only resumeSessionIntoMain', () => {
    lastOpenedSessionId.mockReturnValue('remembered-2')
    hasConnected.set(true)
    gatewayState.set('open')
    renderRestore('/')

    expect(resumeSessionIntoMain).toHaveBeenCalledTimes(1)
    expect(resumeSessionIntoMain.mock.calls[0][0]).toBe('remembered-2')
  })

  it('does not burn the latch before gateway is ready when a remembered id exists', () => {
    lastOpenedSessionId.mockReturnValue('remembered-late')
    renderRestore('/')

    expect(resumeSessionIntoMain).not.toHaveBeenCalled()

    hasConnected.set(true)
    gatewayState.set('open')
    expect(resumeSessionIntoMain).toHaveBeenCalledWith('remembered-late', expect.any(Function))
  })

  it('skips restore when already on a session route', () => {
    lastOpenedSessionId.mockReturnValue('remembered-3')
    hasConnected.set(true)
    gatewayState.set('open')
    renderRestore('/sess-already')

    expect(resumeSessionIntoMain).not.toHaveBeenCalled()
  })

  it('skips restore when a stored session is already selected', () => {
    lastOpenedSessionId.mockReturnValue('remembered-4')
    activeStoredSessionId.set('already-open')
    hasConnected.set(true)
    gatewayState.set('open')
    renderRestore('/')

    expect(resumeSessionIntoMain).not.toHaveBeenCalled()
  })
})
