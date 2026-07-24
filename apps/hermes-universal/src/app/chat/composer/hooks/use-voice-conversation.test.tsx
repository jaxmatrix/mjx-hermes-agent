import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The loop moved into `voice/conversation-controller.ts` (tested there). This hook
// is now a thin mirror of `$voiceConversation` + delegating callbacks, so that is
// all that's tested here.
const controller = vi.hoisted(() => ({
  start: vi.fn(),
  end: vi.fn(),
  stopTurn: vi.fn(),
  toggleMute: vi.fn()
}))

vi.mock('@/voice/conversation-controller', () => ({ voiceConversation: controller }))

import { $voiceConversation, resetVoiceConversation } from '@/store/voice-conversation'

import { useVoiceConversation } from './use-voice-conversation'

const getBinding = (() => ({})) as never

describe('useVoiceConversation (thin hook)', () => {
  beforeEach(() => {
    resetVoiceConversation()
    controller.start.mockClear()
    controller.end.mockClear()
    controller.stopTurn.mockClear()
    controller.toggleMute.mockClear()
  })

  it('mirrors $voiceConversation when the conversation targets this composer', () => {
    const { result, rerender } = renderHook(() => useVoiceConversation({ target: 'main', getBinding }))

    expect(result.current.status).toBe('idle')
    expect(result.current.level).toBe(0)
    expect(result.current.muted).toBe(false)

    act(() => {
      $voiceConversation.set({ active: true, target: 'main', status: 'speaking', level: 0.5, muted: true })
    })
    rerender()

    expect(result.current.status).toBe('speaking')
    expect(result.current.level).toBe(0.5)
    expect(result.current.muted).toBe(true)
  })

  it('ignores a conversation owned by another composer', () => {
    const { result, rerender } = renderHook(() => useVoiceConversation({ target: 'main', getBinding }))

    act(() => {
      $voiceConversation.set({ active: true, target: 'edit', status: 'listening', level: 0.9, muted: false })
    })
    rerender()

    expect(result.current.status).toBe('idle')
    expect(result.current.level).toBe(0)
  })

  it('delegates its controls to the controller', () => {
    const { result } = renderHook(() => useVoiceConversation({ target: 'main', getBinding }))

    act(() => result.current.start())
    act(() => result.current.stopTurn())
    act(() => result.current.toggleMute())
    act(() => result.current.end())

    expect(controller.start).toHaveBeenCalled()
    expect(controller.stopTurn).toHaveBeenCalled()
    expect(controller.toggleMute).toHaveBeenCalled()
    expect(controller.end).toHaveBeenCalled()
  })
})
