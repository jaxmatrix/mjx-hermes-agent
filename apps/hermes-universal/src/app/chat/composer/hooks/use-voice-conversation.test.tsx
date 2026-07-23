import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Hoisted so the module factory below can reach them.
const mic = vi.hoisted(() => ({
  start: vi.fn(async () => undefined),
  stop: vi.fn(async () => ({ audio: new Blob(['audio']), durationMs: 1_000, heardSpeech: true })),
  cancel: vi.fn(),
  lastStartOptions: null as Record<string, unknown> | null
}))

vi.mock('./use-mic-recorder', () => ({
  useMicRecorder: () => ({
    handle: {
      start: async (options: Record<string, unknown>) => {
        mic.lastStartOptions = options

        return mic.start()
      },
      stop: () => mic.stop(),
      cancel: () => mic.cancel()
    },
    level: 0,
    recording: false
  })
}))

vi.mock('@/lib/voice-playback', () => ({
  playSpeechText: vi.fn(async () => undefined),
  stopVoicePlayback: vi.fn()
}))

vi.mock('@/store/notifications', () => ({
  notify: vi.fn(),
  notifyError: vi.fn()
}))

import { playSpeechText } from '@/lib/voice-playback'

import { useVoiceConversation } from './use-voice-conversation'

interface Props {
  busy: boolean
  enabled: boolean
  onFatalError?: () => void
  onSubmit: (text: string) => Promise<void> | void
  onTranscribeAudio?: (audio: Blob) => Promise<string>
  pendingResponse: () => { id: string; pending: boolean; text: string } | null
  consumePendingResponse: () => void
}

/** Let queued microtasks (and the hook's awaited chain) settle. */
async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('useVoiceConversation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mic.lastStartOptions = null
    mic.stop.mockResolvedValue({ audio: new Blob(['audio']), durationMs: 1_000, heardSpeech: true })
  })

  /**
   * The loop used to die after exactly one spoken turn: the completing branch
   * called `setStatus('idle')` while `speak()` had already left status idle, so
   * React bailed out, the driving effect never re-ran, and the single re-arm
   * call site was never reached. This asserts the mic is armed a SECOND time.
   */
  it('re-arms the microphone after a completed spoken turn', async () => {
    // The reply the assistant "streams back" once the turn is submitted.
    let response: { id: string; pending: boolean; text: string } | null = null

    const props: Props = {
      busy: false,
      enabled: true,
      onSubmit: vi.fn(async () => undefined),
      onTranscribeAudio: vi.fn(async () => 'hello there'),
      pendingResponse: () => response,
      consumePendingResponse: vi.fn(() => {
        response = null
      })
    }

    // The hook arms on the false -> true transition of `enabled`, so mount
    // disabled and then switch it on (what toggling conversation mode does).
    const { rerender } = renderHook((p: Props) => useVoiceConversation(p), {
      initialProps: { ...props, enabled: false }
    })

    await flush()
    rerender(props)
    await flush()

    // Turn 1: armed once.
    expect(mic.start).toHaveBeenCalledTimes(1)

    // VAD says the user stopped talking -> handleTurn starts (async).
    // `busy` must flip true BEFORE handleTurn settles on 'thinking', exactly as
    // it does in the app when the turn is submitted. Otherwise the turn ends via
    // the benign `!busy && status === 'thinking'` branch and never exercises the
    // speak() -> idle path where the bug lives.
    act(() => {
      ;(mic.lastStartOptions?.onSilence as () => void)()
    })
    rerender({ ...props, busy: true })
    await flush()

    expect(props.onSubmit).toHaveBeenCalledWith('hello there')

    // The assistant starts streaming its reply.
    response = { id: 'reply-1', pending: true, text: 'Hi there.' }
    rerender({ ...props, busy: true })
    await flush()

    // The stable chunk is spoken while the reply is still streaming.
    expect(playSpeechText).toHaveBeenCalledWith('Hi there.', expect.anything())

    // The reply finishes. speak() has already left status 'idle', so the
    // completing branch's setStatus('idle') is a no-op -> no re-render -> the
    // old code never reached its single re-arm call site.
    response = { id: 'reply-1', pending: false, text: 'Hi there.' }
    rerender({ ...props, busy: false })
    await flush()

    expect(mic.start).toHaveBeenCalledTimes(2)
  })

  it('re-arms when a turn produced no audio, without ending the conversation', async () => {
    mic.stop.mockResolvedValue(null as never)

    const onFatalError = vi.fn()
    const props: Props = {
      busy: false,
      enabled: true,
      onFatalError,
      onSubmit: vi.fn(async () => undefined),
      onTranscribeAudio: vi.fn(async () => ''),
      pendingResponse: () => null,
      consumePendingResponse: vi.fn()
    }

    const { rerender } = renderHook((p: Props) => useVoiceConversation(p), {
      initialProps: { ...props, enabled: false }
    })

    await flush()
    rerender(props)
    await flush()
    expect(mic.start).toHaveBeenCalledTimes(1)

    await act(async () => {
      ;(mic.lastStartOptions?.onSilence as () => void)()
    })
    await flush()

    // An empty capture is a normal outcome: listen again, do not tear down.
    expect(mic.start).toHaveBeenCalledTimes(2)
    expect(onFatalError).not.toHaveBeenCalled()
    expect(props.onSubmit).not.toHaveBeenCalled()
  })
})
