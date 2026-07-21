import { getHermesConfigRecord, saveHermesConfig } from '@/hermes'
import { atom } from '@/store/atom'

// "Read replies aloud" — mirrors the canonical `voice.auto_tts` config key (also
// the Settings → Voice switch, honored by the messaging gateway) so the composer
// toggle and the settings switch are one source of truth. Ported from
// apps/desktop/src/store/voice-prefs.ts.
export const $autoSpeakReplies = atom<boolean>(false)

let seeded = false

/** Seed the atom from the current config once (chat mount). Best-effort. */
export async function seedAutoSpeak(): Promise<void> {
  if (seeded) {
    return
  }

  seeded = true

  try {
    const record = await getHermesConfigRecord()
    const voice = record.voice && typeof record.voice === 'object' ? (record.voice as Record<string, unknown>) : {}
    $autoSpeakReplies.set(Boolean(voice.auto_tts))
  } catch {
    // Keep the default (off) if config can't be read.
  }
}

/** Flip the preference and persist it (read-modify-write the whole record —
 *  the same path Settings uses). Optimistic, reverts on write failure. */
export async function setAutoSpeakReplies(enabled: boolean): Promise<void> {
  const previous = $autoSpeakReplies.get()

  if (previous === enabled) {
    return
  }

  $autoSpeakReplies.set(enabled)

  try {
    const record = await getHermesConfigRecord()
    const voice = record.voice && typeof record.voice === 'object' ? (record.voice as Record<string, unknown>) : {}
    await saveHermesConfig({ ...record, voice: { ...voice, auto_tts: enabled } })
  } catch (error) {
    $autoSpeakReplies.set(previous)
    throw error
  }
}
