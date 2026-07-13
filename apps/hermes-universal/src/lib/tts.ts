import { speakText } from '@/hermes'
import { atom } from '@/store/atom'

// Text-to-speech playback. speakText returns a data-URL the webview can play
// directly via an <audio> element — no AudioContext needed. One clip plays at a
// time; a new speak (or stopSpeaking) interrupts the previous.
export const $ttsSpeaking = atom(false)

let current: HTMLAudioElement | null = null

export function stopSpeaking(): void {
  if (current) {
    current.pause()
    current.src = ''
    current = null
  }
  $ttsSpeaking.set(false)
}

export async function speakNow(text: string): Promise<void> {
  const trimmed = text.trim()
  if (!trimmed || typeof Audio === 'undefined') {
    return
  }
  stopSpeaking()
  try {
    const res = await speakText(trimmed)
    if (!res.ok || !res.data_url) {
      return
    }
    const audio = new Audio(res.data_url)
    current = audio
    $ttsSpeaking.set(true)
    const clear = () => {
      if (current === audio) {
        current = null
        $ttsSpeaking.set(false)
      }
    }
    audio.onended = clear
    audio.onerror = clear
    await audio.play().catch(clear)
  } catch {
    stopSpeaking()
  }
}
