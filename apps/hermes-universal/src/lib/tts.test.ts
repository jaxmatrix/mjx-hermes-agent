import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { speakText } = vi.hoisted(() => ({
  speakText: vi.fn<(text: string) => Promise<{ ok: boolean; data_url?: string }>>(async () => ({
    ok: true,
    data_url: 'data:audio/mp3;base64,AAAA'
  }))
}))

vi.mock('@/hermes', () => ({ speakText }))

import { speakUntilDone, stopSpeaking } from './tts'

// jsdom's HTMLMediaElement.play throws "Not implemented"; stub Audio with a fake
// whose end/error we can trigger, and that captures the latest instance.
class FakeAudio {
  static last: FakeAudio | null = null
  onended: (() => void) | null = null
  onerror: (() => void) | null = null
  src = ''

  constructor(public readonly dataUrl?: string) {
    FakeAudio.last = this
  }

  play(): Promise<void> {
    return Promise.resolve()
  }

  pause(): void {}
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

describe('speakUntilDone', () => {
  beforeEach(() => {
    speakText.mockClear()
    speakText.mockResolvedValue({ ok: true, data_url: 'data:audio/mp3;base64,AAAA' })
    FakeAudio.last = null
    vi.stubGlobal('Audio', FakeAudio)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("resolves 'ended' when the clip finishes", async () => {
    const promise = speakUntilDone('hello there')
    await flush()
    expect(FakeAudio.last).not.toBeNull()

    FakeAudio.last?.onended?.()
    await expect(promise).resolves.toBe('ended')
  })

  it("resolves 'stopped' when interrupted mid-playback (barge-in)", async () => {
    const promise = speakUntilDone('a long reply')
    await flush()

    stopSpeaking()
    await expect(promise).resolves.toBe('stopped')
  })

  it("resolves 'skipped' for empty text without touching the network", async () => {
    await expect(speakUntilDone('   ')).resolves.toBe('skipped')
    expect(speakText).not.toHaveBeenCalled()
  })

  it("resolves 'skipped' when the TTS backend returns no audio", async () => {
    speakText.mockResolvedValueOnce({ ok: false })
    await expect(speakUntilDone('hello')).resolves.toBe('skipped')
  })
})
