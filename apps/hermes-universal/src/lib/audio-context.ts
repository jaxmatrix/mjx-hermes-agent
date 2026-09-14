// One lazily-created AudioContext for the app's synthesized UI cues (wake
// chime, turn-completion sound, thinking blips) and the TTS playback analyser.
// Browsers cap how many contexts a page may open — Android most tightly — and
// these are short oscillator bursts plus one element tap that need no isolation
// from each other, so they share one instead of each holding its own. Nothing
// closes it: it lives for the window.
//
// Ported from apps/desktop/src/lib/audio-context.ts, with universal's TTS
// playback analyser (`app/chat/composer/voice-activity.tsx`) folded in as a
// fourth caller — desktop keeps that one separate, universal does not, because
// Android counts it against the same cap.
//
// NOT shared: `lib/tts.ts` and `voice/web-engine.ts` each own a context they
// CLOSE (barge-in cuts the speech stream's context; capture closes the mic's).
// Closing this one would take the cues down with it.

let ctx: AudioContext | null = null

/** The shared AudioContext, or null where WebAudio is unavailable. */
export function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') {
    return null
  }

  try {
    if (!ctx || ctx.state === 'closed') {
      const Ctor =
        window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext

      if (!Ctor) {
        return null
      }

      ctx = new Ctor()
    }

    // Autoplay policies can leave the context suspended until a gesture; a
    // resume() here recovers it once the user has interacted with the window.
    // (On WebKitGTK this is the difference between blips and silence.)
    if (ctx.state === 'suspended') {
      void ctx.resume().catch(() => undefined)
    }

    return ctx
  } catch {
    return null
  }
}
