import { useRef, useState } from 'react'

import { transcribeAudio } from '@/hermes'

// Voice dictation (Gc9/R10). Captures mic audio in the webview (getUserMedia +
// MediaRecorder), then sends the clip to the already-ported transcribeAudio
// (POST /api/audio/transcribe) and hands back the transcript.
//
// FIXME(Gc9): Android needs RECORD_AUDIO in the (gitignored, regenerated)
// AndroidManifest + a WebChromeClient mic-permission grant — device setup step.
// FIXME(Gc9): auto-speak assistant replies via speakText() is deferred.

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

export interface VoiceRecorder {
  recording: boolean
  transcribing: boolean
  toggle: () => void
}

export function useVoiceRecorder(onTranscript: (text: string) => void): VoiceRecorder {
  const [recording, setRecording] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])

  const stopTracks = () => {
    streamRef.current?.getTracks().forEach(track => track.stop())
    streamRef.current = null
  }

  const finish = async () => {
    const type = recorderRef.current?.mimeType || 'audio/webm'
    const blob = new Blob(chunksRef.current, { type })
    stopTracks()
    if (!blob.size) return
    setTranscribing(true)
    try {
      const dataUrl = await blobToDataUrl(blob)
      const res = await transcribeAudio(dataUrl, blob.type)
      if (res.transcript) onTranscript(res.transcript)
    } catch {
      /* mic/transcribe unavailable */
    } finally {
      setTranscribing(false)
    }
  }

  const start = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      const recorder = new MediaRecorder(stream)
      chunksRef.current = []
      recorder.ondataavailable = e => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }
      recorder.onstop = () => void finish()
      recorder.start()
      recorderRef.current = recorder
      setRecording(true)
    } catch {
      stopTracks()
      setRecording(false)
    }
  }

  const stop = () => {
    recorderRef.current?.stop()
    setRecording(false)
  }

  return {
    recording,
    transcribing,
    toggle: () => (recording ? stop() : void start())
  }
}
