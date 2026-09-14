import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Every cue module used to keep its own `let ctx` (four copies of the same
// getter: wake chime, completion cue, thinking blips, the TTS playback
// analyser). Browsers cap how many AudioContexts a page may open and Android's
// cap is the tight one, so these assert the count stays at ONE across modules —
// not merely that each module still makes a noise.

class FakeParam {
  setValueAtTime = vi.fn()
  linearRampToValueAtTime = vi.fn()
  exponentialRampToValueAtTime = vi.fn()
  setTargetAtTime = vi.fn()
  value = 0
}

class FakeNode {
  type = 'sine'
  buffer: unknown = null
  frequency = new FakeParam()
  detune = new FakeParam()
  gain = new FakeParam()
  Q = new FakeParam()
  normalize = false
  connect = vi.fn()
  disconnect = vi.fn()
  start = vi.fn()
  stop = vi.fn()
}

let constructed = 0

class FakeAudioContext {
  static nextState: 'closed' | 'running' | 'suspended' = 'running'
  state = FakeAudioContext.nextState
  currentTime = 0
  sampleRate = 48000
  destination = {}
  resume = vi.fn().mockResolvedValue(undefined)

  constructor() {
    constructed += 1
  }

  createOscillator = () => new FakeNode()
  createGain = () => new FakeNode()
  createBiquadFilter = () => new FakeNode()
  createConvolver = () => new FakeNode()
  createBufferSource = () => new FakeNode()
  createBuffer = (_channels: number, length: number) => ({
    getChannelData: () => new Float32Array(length),
    length
  })
}

beforeEach(() => {
  constructed = 0
  FakeAudioContext.nextState = 'running'
  vi.resetModules()
  vi.stubGlobal('AudioContext', FakeAudioContext)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('getAudioContext', () => {
  it('constructs once and hands the same context back', async () => {
    const { getAudioContext } = await import('./audio-context')

    const first = getAudioContext()
    const second = getAudioContext()

    expect(first).toBe(second)
    expect(constructed).toBe(1)
  })

  it('resumes a context the autoplay policy suspended, on every fetch', async () => {
    FakeAudioContext.nextState = 'suspended'

    const { getAudioContext } = await import('./audio-context')
    const context = getAudioContext() as unknown as FakeAudioContext

    expect(context.resume).toHaveBeenCalledTimes(1)
    getAudioContext()
    expect(context.resume).toHaveBeenCalledTimes(2)
    expect(constructed).toBe(1)
  })

  it('returns null where WebAudio is unavailable', async () => {
    vi.stubGlobal('AudioContext', undefined)

    const { getAudioContext } = await import('./audio-context')

    expect(getAudioContext()).toBeNull()
  })

  it('opens ONE context for the wake chime, the completion cue and the thinking blips together', async () => {
    vi.useFakeTimers()

    const [{ playWakeSound }, { playCompletionSound }, thinking, { getAudioContext }] = await Promise.all([
      import('./wake-sound'),
      import('./completion-sound'),
      import('./thinking-sound'),
      import('./audio-context')
    ])

    playWakeSound()
    playCompletionSound()
    thinking.startThinkingSound()
    vi.advanceTimersByTime(500)
    thinking.stopThinkingSound()
    getAudioContext()

    // The whole point: four cue paths, one context.
    expect(constructed).toBe(1)
  })
})
