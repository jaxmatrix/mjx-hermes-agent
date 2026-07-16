import { $ttsSpeaking } from '@/lib/tts'
import { atom } from '@/store/atom'

// Per-message voice-playback status for the assistant action bar's "Read aloud"
// item. Adapts desktop's `@/store/voice-playback` contract onto universal's
// simpler `@/lib/tts` engine (which only exposes a boolean `$ttsSpeaking`).
//
// Desktop shape kept intact so the ported `ReadAloudItem` works unchanged:
//   source   — which affordance started playback ('read-aloud' | 'auto' | null)
//   messageId — the message being read (so only its row shows active state)
//   status   — 'idle' | 'preparing' (fetching audio) | 'speaking' (playing)
export type VoicePlaybackSource = 'auto' | 'read-aloud' | null
export type VoicePlaybackStatus = 'idle' | 'preparing' | 'speaking'

export interface VoicePlaybackState {
  source: VoicePlaybackSource
  messageId: string | null
  status: VoicePlaybackStatus
}

const IDLE: VoicePlaybackState = { source: null, messageId: null, status: 'idle' }

export const $voicePlayback = atom<VoicePlaybackState>(IDLE)

export function resetVoicePlayback(): void {
  if ($voicePlayback.get().status !== 'idle') {
    $voicePlayback.set(IDLE)
  }
}

// Keep the richer per-message state in lockstep with the tts engine's boolean:
//   • audio actually started → promote a pending 'preparing' to 'speaking'
//   • audio ended / was stopped → fall back to idle
$ttsSpeaking.subscribe(speaking => {
  const current = $voicePlayback.get()

  if (speaking) {
    if (current.source && current.status !== 'speaking') {
      $voicePlayback.set({ ...current, status: 'speaking' })
    }

    return
  }

  resetVoicePlayback()
})
