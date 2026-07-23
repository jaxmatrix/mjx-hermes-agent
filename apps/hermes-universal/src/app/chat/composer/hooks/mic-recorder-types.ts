/**
 * Shared contract for the microphone recorders.
 *
 * Two implementations satisfy it: `useNativeMicRecorder` (Rust/cpal capture over
 * IPC — the reliable path, since WebKitGTK's MediaRecorder yields empty blobs on
 * Linux) and `useWebMicRecorder` (getUserMedia + MediaRecorder). `useMicRecorder`
 * picks between them. Types live here so neither implementation has to import the
 * other (and so the dispatcher stays free of import cycles).
 */

export interface MicRecorderOptions {
  onLevel?: (level: number) => void
  onError?: (error: Error) => void
  onSilence?: () => void
  silenceLevel?: number
  silenceMs?: number
  idleSilenceMs?: number
}

export interface MicRecording {
  audio: Blob
  durationMs: number
  heardSpeech: boolean
}

export interface MicRecorderErrorCopy {
  microphoneAccessDenied: string
  microphoneConstraintsUnsupported: string
  microphoneInUse: string
  microphonePermissionDenied: string
  microphoneStartFailed: string
  microphoneUnsupported: string
  noMicrophone: string
}

export interface MicRecorderHandle {
  start: (options?: MicRecorderOptions) => Promise<void>
  stop: () => Promise<MicRecording | null>
  cancel: () => void
}

export interface MicRecorder {
  handle: MicRecorderHandle
  level: number
  recording: boolean
}
