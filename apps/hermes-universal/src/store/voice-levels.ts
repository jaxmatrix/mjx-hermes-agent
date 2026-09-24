/**
 * Voice input/output level atoms (MJXHRM-90). Off AUTO `voice-prefs.ts` so absorb
 * cannot drop them; `voice/**` surfaces and Settings → Voice still need these.
 */
import { getHermesConfigRecord, saveHermesConfig } from '@/hermes'
import { atom } from '@/store/atom'
import type { VoiceVad } from '@/voice/types'

export const DEFAULT_VOICE_LEVELS = {
  inputGain: 3.0,
  inputThreshold: 0.075,
  bargeinThreshold: 0.16,
  outputVolume: 1.0
} as const

export const VOICE_LEVEL_RANGES = {
  inputGain: { min: 0.25, max: 20, step: 0.25 },
  inputThreshold: { min: 0, max: 1, step: 0.005 },
  bargeinThreshold: { min: 0, max: 1, step: 0.005 },
  outputVolume: { min: 0, max: 1, step: 0.05 }
} as const

export const $voiceInputGain = atom<number>(DEFAULT_VOICE_LEVELS.inputGain)
export const $voiceInputThreshold = atom<number>(DEFAULT_VOICE_LEVELS.inputThreshold)
export const $voiceBargeinThreshold = atom<number>(DEFAULT_VOICE_LEVELS.bargeinThreshold)
export const $voiceOutputVolume = atom<number>(DEFAULT_VOICE_LEVELS.outputVolume)

export const VOICE_LEVEL_KEYS = {
  inputGain: 'input_gain',
  inputThreshold: 'input_threshold',
  bargeinThreshold: 'bargein_threshold',
  outputVolume: 'output_volume'
} as const

export type VoiceLevelName = keyof typeof VOICE_LEVEL_KEYS

const LEVEL_ATOMS = {
  inputGain: $voiceInputGain,
  inputThreshold: $voiceInputThreshold,
  bargeinThreshold: $voiceBargeinThreshold,
  outputVolume: $voiceOutputVolume
} as const

export function sanitizeVoiceLevel(name: VoiceLevelName, value: unknown): number {
  const range = VOICE_LEVEL_RANGES[name]
  const parsed = typeof value === 'number' ? value : Number(value)

  if (value === null || value === undefined || value === '' || !Number.isFinite(parsed)) {
    return DEFAULT_VOICE_LEVELS[name]
  }

  return Math.min(range.max, Math.max(range.min, parsed))
}

export function conversationVoiceVad(): VoiceVad {
  return {
    levelGain: $voiceInputGain.get(),
    speechLevel: $voiceInputThreshold.get(),
    bargeinSpeechLevel: $voiceBargeinThreshold.get()
  }
}

export function voiceInputGain(): number {
  return $voiceInputGain.get()
}

export function setVoiceLevel(name: VoiceLevelName, value: number): void {
  LEVEL_ATOMS[name].set(sanitizeVoiceLevel(name, value))
}

const CONFIG_KEY_BY_LEVEL: Record<VoiceLevelName, string> = {
  inputGain: 'input_gain',
  inputThreshold: 'input_threshold',
  bargeinThreshold: 'bargein_threshold',
  outputVolume: 'output_volume'
}

/** Seed level atoms from `config.yaml` voice.* (Settings → Voice panel mount). */
export async function seedVoicePrefs(): Promise<void> {
  try {
    const config = await getHermesConfigRecord()
    const voice = config?.voice

    if (!voice || typeof voice !== 'object') {
      return
    }

    const record = voice as Record<string, unknown>

    for (const name of Object.keys(LEVEL_ATOMS) as VoiceLevelName[]) {
      const raw = record[CONFIG_KEY_BY_LEVEL[name]]

      if (raw !== undefined) {
        setVoiceLevel(name, sanitizeVoiceLevel(name, raw))
      }
    }
  } catch {
    // Offline / headless — defaults stand.
  }
}

export async function persistVoiceLevel(name: VoiceLevelName, value: number): Promise<void> {
  setVoiceLevel(name, value)

  try {
    const config = await getHermesConfigRecord()
    const voice = config?.voice && typeof config.voice === 'object' ? { ...config.voice } : {}

    await saveHermesConfig({
      ...config,
      voice: { ...voice, [CONFIG_KEY_BY_LEVEL[name]]: LEVEL_ATOMS[name].get() }
    })
  } catch {
    // Best-effort; sliders still move locally.
  }
}
