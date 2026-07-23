import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { useEffect, useRef, useState } from 'react'

import { ensureMicPermission } from '@/lib/mic-permission'

import type {
  MicRecorder,
  MicRecorderErrorCopy,
  MicRecorderHandle,
  MicRecorderOptions,
  MicRecording
} from './mic-recorder-types'

/** Mirrors the Rust `AudioClip` (audio.rs) — a base64 WAV/FLAC container. */
interface AudioClip {
  base64: string
  mimeType: string
  durationMs: number
  sampleRate: number
}

/** Container the Rust encoder should produce. WAV is the robust default. */
type NativeAudioFormat = 'wav' | 'flac'

const FORMAT: NativeAudioFormat = 'wav'

/** Returns the raw `ArrayBuffer` — it is a `BlobPart`, so no view juggling. */
function decodeBase64(base64: string): ArrayBuffer {
  const binary = atob(base64)
  const buffer = new ArrayBuffer(binary.length)
  const bytes = new Uint8Array(buffer)

  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }

  return buffer
}

/**
 * Native microphone recorder: capture runs in Rust (`cpal`), not the webview.
 *
 * Why: WebKitGTK (the Linux Tauri webview) only supports `audio/mp4` in
 * `MediaRecorder` and produces an EMPTY blob even with the system AAC encoder
 * installed, so dictation silently never transcribed. Rust captures raw PCM and
 * encodes with bundled pure-Rust codecs, so there is no system-codec dependency.
 *
 * Contract match: this is a drop-in for `useWebMicRecorder`. The VAD/silence
 * detection below is ported verbatim from the old `AnalyserNode` meter loop — it
 * just consumes Rust-emitted RMS levels (`audio://{id}/level`) instead of reading
 * an audio graph, so `silenceLevel`/`silenceMs`/`idleSilenceMs`/`onSilence` behave
 * identically. Per the ws/pty convention we subscribe BEFORE invoking start so no
 * level event is missed.
 */
export function useNativeMicRecorder(copy: MicRecorderErrorCopy): MicRecorder {
  const [level, setLevel] = useState(0)
  const [recording, setRecording] = useState(false)

  const idRef = useRef<string | null>(null)
  const unlistenRef = useRef<UnlistenFn | null>(null)
  const optionsRef = useRef<MicRecorderOptions>({})
  const startedAtRef = useRef(0)
  const heardSpeechRef = useRef(false)
  const silenceTriggeredRef = useRef(false)
  const silenceStartedAtRef = useRef<number | null>(null)

  const cleanup = () => {
    unlistenRef.current?.()
    unlistenRef.current = null
    idRef.current = null
    optionsRef.current = {}
    setLevel(0)
    setRecording(false)
    silenceTriggeredRef.current = false
    silenceStartedAtRef.current = null
  }

  // Cancel a live capture if the component unmounts mid-recording, so the Rust
  // capture thread doesn't outlive the UI holding it.
  useEffect(
    () => () => {
      const id = idRef.current

      if (id) {
        void invoke('audio_cancel_recording', { id }).catch(() => undefined)
      }

      unlistenRef.current?.()
      unlistenRef.current = null
    },
    []
  )

  /**
   * Ported verbatim from the browser meter's `tick()`: track whether speech was
   * ever heard, then fire `onSilence` once either (a) speech was heard and the
   * level has stayed below the threshold for `silenceMs`, or (b) no speech was
   * ever heard within `idleSilenceMs`.
   */
  const onLevel = (normalized: number) => {
    const options = optionsRef.current
    const now = Date.now()

    setLevel(normalized)
    options.onLevel?.(normalized)

    const speechThreshold = options.silenceLevel ?? 0
    const silenceMs = options.silenceMs ?? 0
    const idleSilenceMs = options.idleSilenceMs ?? 0

    if (speechThreshold > 0 && options.onSilence && !silenceTriggeredRef.current) {
      if (normalized >= speechThreshold) {
        heardSpeechRef.current = true
        silenceStartedAtRef.current = null
      } else if (heardSpeechRef.current && silenceMs > 0) {
        silenceStartedAtRef.current ??= now

        if (now - silenceStartedAtRef.current >= silenceMs) {
          silenceTriggeredRef.current = true
          options.onSilence()
        }
      } else if (!heardSpeechRef.current && idleSilenceMs > 0 && now - startedAtRef.current >= idleSilenceMs) {
        silenceTriggeredRef.current = true
        options.onSilence()
      }
    }
  }

  const start: MicRecorderHandle['start'] = async (options = {}) => {
    if (idRef.current) {
      return
    }

    // Mobile pre-flights the OS permission natively; desktop short-circuits to
    // true (Linux has no per-app mic gate, macOS prompts via TCC on first capture
    // using the Info.plist NSMicrophoneUsageDescription).
    if (!(await ensureMicPermission())) {
      throw new Error(copy.microphonePermissionDenied)
    }

    const id = crypto.randomUUID()
    optionsRef.current = options
    heardSpeechRef.current = false
    silenceTriggeredRef.current = false
    silenceStartedAtRef.current = null
    startedAtRef.current = Date.now()

    // Subscribe before invoking so no level event is dropped (ws/pty convention).
    const unlisten = await listen<number>(`audio://${id}/level`, event => {
      if (typeof event.payload === 'number') {
        onLevel(event.payload)
      }
    })

    try {
      await invoke('audio_start_recording', { id })
    } catch (error) {
      unlisten()
      optionsRef.current = {}
      throw nativeError(error, copy)
    }

    unlistenRef.current = unlisten
    idRef.current = id
    setRecording(true)
  }

  const stop: MicRecorderHandle['stop'] = async () => {
    const id = idRef.current

    if (!id) {
      cleanup()

      return null
    }

    const options = optionsRef.current
    const durationMs = Date.now() - startedAtRef.current
    const heardSpeech = heardSpeechRef.current

    try {
      const clip = await invoke<AudioClip>('audio_stop_recording', { id, format: FORMAT })
      const bytes = decodeBase64(clip.base64)

      if (!bytes.byteLength) {
        throw new Error(copy.microphoneStartFailed)
      }

      return {
        audio: new Blob([bytes], { type: clip.mimeType }),
        durationMs: clip.durationMs || durationMs,
        heardSpeech
      } satisfies MicRecording
    } catch (error) {
      // Never fail silently: an empty/failed capture used to resolve `null` with no
      // toast, which is exactly why the Linux breakage went unnoticed for so long.
      options.onError?.(nativeError(error, copy))

      return null
    } finally {
      cleanup()
    }
  }

  const cancel: MicRecorderHandle['cancel'] = () => {
    const id = idRef.current

    if (id) {
      void invoke('audio_cancel_recording', { id }).catch(() => undefined)
    }

    cleanup()
  }

  const handle: MicRecorderHandle = { start, stop, cancel }

  return { handle, level, recording }
}

/** Map the Rust command's error strings onto the existing localized copy. */
function nativeError(error: unknown, copy: MicRecorderErrorCopy): Error {
  const raw = typeof error === 'string' ? error : error instanceof Error ? error.message : ''

  if (raw.includes('no_input_device') || raw.includes('no_input_config')) {
    return new Error(copy.noMicrophone)
  }

  if (raw.includes('unsupported_platform') || raw.includes('unsupported_sample_format')) {
    return new Error(copy.microphoneUnsupported)
  }

  if (raw.includes('already_recording')) {
    return new Error(copy.microphoneInUse)
  }

  if (raw.includes('stream_build') || raw.includes('stream_play')) {
    return new Error(copy.microphoneStartFailed)
  }

  if (error instanceof Error) {
    return error
  }

  return new Error(raw || copy.microphoneStartFailed)
}
