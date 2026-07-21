import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/hermes', () => ({
  getHermesConfigRecord: vi.fn(async () => ({ voice: { auto_tts: true }, model: 'x' })),
  saveHermesConfig: vi.fn(async () => ({ ok: true }))
}))

import { getHermesConfigRecord, saveHermesConfig } from '@/hermes'

import { $autoSpeakReplies, setAutoSpeakReplies } from './voice-prefs'

const save = vi.mocked(saveHermesConfig)
const load = vi.mocked(getHermesConfigRecord)

describe('voice-prefs (auto-speak)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    $autoSpeakReplies.set(false)
  })
  afterEach(() => $autoSpeakReplies.set(false))

  it('persists the flag into the whole config record (voice.auto_tts)', async () => {
    load.mockResolvedValueOnce({ voice: { provider: 'edge' }, model: 'x' } as never)
    await setAutoSpeakReplies(true)
    expect($autoSpeakReplies.get()).toBe(true)
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'x', voice: expect.objectContaining({ provider: 'edge', auto_tts: true }) })
    )
  })

  it('reverts optimistically when the config write fails', async () => {
    load.mockResolvedValueOnce({ voice: {}, model: 'x' } as never)
    save.mockRejectedValueOnce(new Error('nope'))
    await expect(setAutoSpeakReplies(true)).rejects.toThrow()
    expect($autoSpeakReplies.get()).toBe(false)
  })

  it('is a no-op when the value is unchanged', async () => {
    await setAutoSpeakReplies(false)
    expect(save).not.toHaveBeenCalled()
  })
})
