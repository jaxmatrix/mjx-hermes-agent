import { useRef, useState } from 'react'

import { IS_DESKTOP } from '@/lib/platform'

import type { MicRecorder, MicRecorderErrorCopy, MicRecorderHandle } from './mic-recorder-types'
import { useNativeMicRecorder } from './use-native-mic-recorder'
import { useWebMicRecorder } from './use-web-mic-recorder'

export type {
  MicRecorder,
  MicRecorderErrorCopy,
  MicRecorderHandle,
  MicRecorderOptions,
  MicRecording
} from './mic-recorder-types'

type ActiveRecorder = 'native' | 'web'

/**
 * Microphone recorder used by dictation and the voice-conversation loop.
 *
 * Picks between two implementations:
 * - **Desktop → native (Rust/cpal).** WebKitGTK's `MediaRecorder` only supports
 *   `audio/mp4` and produces an EMPTY blob even with the system AAC encoder
 *   present, so dictation silently never transcribed on Linux. The native path
 *   captures PCM in Rust and encodes with bundled pure-Rust codecs — no system
 *   codec dependency, so it behaves the same on every desktop OS.
 * - **Mobile / plain-browser / tests → webview `MediaRecorder`,** which works
 *   there today. (Phase B will move mobile onto the native path too.)
 *
 * Both hooks are always instantiated so hook order is stable; only the selected
 * one is ever started. If the native path fails to start on desktop (no input
 * device, unsupported format), we fall back to `MediaRecorder` — worthwhile on
 * macOS/Windows, where it actually works.
 */
export function useMicRecorder(copy: MicRecorderErrorCopy): MicRecorder {
  const native = useNativeMicRecorder(copy)
  const web = useWebMicRecorder(copy)

  const [active, setActive] = useState<ActiveRecorder | null>(null)
  // Mirrors `active` for synchronous reads inside stop/cancel, which can run
  // before a state update has been applied.
  const activeRef = useRef<ActiveRecorder | null>(null)

  const select = (next: ActiveRecorder | null) => {
    activeRef.current = next
    setActive(next)
  }

  const start: MicRecorderHandle['start'] = async (options = {}) => {
    if (activeRef.current) {
      return
    }

    if (IS_DESKTOP) {
      try {
        await native.handle.start(options)
        select('native')

        return
      } catch (error) {
        // Fall through to the webview recorder. On Linux this will very likely
        // also fail (that is the whole reason the native path exists), but the
        // error it raises is the one the caller should see.
        console.warn('native mic recorder unavailable, falling back to MediaRecorder', error)
      }
    }

    await web.handle.start(options)
    select('web')
  }

  const stop: MicRecorderHandle['stop'] = async () => {
    const current = activeRef.current
    select(null)

    if (current === 'native') {
      return native.handle.stop()
    }

    if (current === 'web') {
      return web.handle.stop()
    }

    return null
  }

  const cancel: MicRecorderHandle['cancel'] = () => {
    const current = activeRef.current
    select(null)

    if (current === 'native') {
      native.handle.cancel()
    } else if (current === 'web') {
      web.handle.cancel()
    }
  }

  const handle: MicRecorderHandle = { start, stop, cancel }
  const source = active === 'native' ? native : active === 'web' ? web : null

  return {
    handle,
    level: source?.level ?? 0,
    recording: source?.recording ?? false
  }
}
