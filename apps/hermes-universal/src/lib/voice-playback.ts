import { speakNow, stopSpeaking } from '@/lib/tts'
import {
  $voicePlayback,
  resetVoicePlayback,
  type VoicePlaybackSource
} from '@/store/voice-playback'

// Read-aloud driver. Mirrors desktop's `@/lib/voice-playback` contract closely
// enough that the ported action-bar `ReadAloudItem` runs unchanged, but plays
// through universal's `@/lib/tts` engine (data-URL <audio>) instead of the
// desktop streaming-voice pipeline.
//
// The 'preparing' → 'speaking' → 'idle' transitions are driven by the
// `$ttsSpeaking` subscription in store/voice-playback; here we only stamp the
// initiating source/message and clear on failure.
export async function playSpeechText(
  text: string,
  { messageId, source }: { messageId: string; source: Exclude<VoicePlaybackSource, null> }
): Promise<void> {
  $voicePlayback.set({ source, messageId, status: 'preparing' })

  try {
    await speakNow(text)

    // speakNow resolves once playback has begun (or bailed on empty/error). If
    // no audio started, the subscription never promoted us to 'speaking' — drop
    // back to idle so the button doesn't stick on "Preparing…".
    if ($voicePlayback.get().status === 'preparing') {
      resetVoicePlayback()
    }
  } catch (error) {
    resetVoicePlayback()
    throw error
  }
}

export function stopVoicePlayback(): void {
  stopSpeaking()
  resetVoicePlayback()
}
