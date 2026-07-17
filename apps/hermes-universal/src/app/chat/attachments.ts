import { open } from '@tauri-apps/plugin-dialog'
import { readFile } from '@tauri-apps/plugin-fs'

import { ensureSession } from '@/store/chat'
import { requestGateway } from '@/store/gateway'

// Attachment staging (Gc8/R7). Pick a file → read bytes → data-URL → file.attach
// (which stages it server-side and returns a @file:/@image: ref) → the ref is
// spliced into the prompt text on submit (the desktop model).
// FIXME(Gc8): base64 of a large file blocks the main thread; Android SAF
// content-URIs vs fs.readFile paths need on-device validation.

const MIME_BY_EXT: Record<string, string> = {
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  json: 'application/json',
  md: 'text/markdown',
  pdf: 'application/pdf',
  png: 'image/png',
  svg: 'image/svg+xml',
  txt: 'text/plain',
  webp: 'image/webp'
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() || path
}

function mimeFor(name: string): string {
  return MIME_BY_EXT[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream'
}

function toDataUrl(bytes: Uint8Array, mime: string): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return `data:${mime};base64,${btoa(binary)}`
}

export interface StagedAttachment {
  ref: string
  name: string
}

/**
 * Stage an already-known absolute path via file.attach (read bytes → data-URL →
 * gateway) and return its prompt ref. Shared by the picker and the OS file-drop
 * handler (a Tauri drop hands over paths directly). Returns null on failure —
 * e.g. a dropped directory, whose readFile throws, is skipped rather than fatal.
 */
export async function stageAttachmentFromPath(path: string): Promise<StagedAttachment | null> {
  try {
    const name = basename(path)
    const bytes = await readFile(path)
    const dataUrl = toDataUrl(bytes, mimeFor(name))
    const sessionId = await ensureSession()

    const res = await requestGateway<{ ref_text?: string }>('file.attach', {
      name,
      path,
      session_id: sessionId,
      data_url: dataUrl
    })

    return res.ref_text ? { ref: res.ref_text, name } : null
  } catch {
    return null
  }
}

/** Open the picker, stage the file via file.attach, return its prompt ref. */
export async function pickAttachment(): Promise<StagedAttachment | null> {
  const path = await open({ multiple: false })
  if (typeof path !== 'string') return null

  return stageAttachmentFromPath(path)
}
