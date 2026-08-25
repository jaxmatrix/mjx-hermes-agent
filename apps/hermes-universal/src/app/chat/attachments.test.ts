import { beforeEach, describe, expect, it, vi } from 'vitest'

import { selectRemotePaths } from '@/lib/desktop-fs'
import { ensureSession } from '@/store/chat'
import { requestGateway } from '@/store/gateway'
import { notifyError } from '@/store/notifications'
import { requestForSession } from '@/store/session-request-router'

import {
  attachToSession,
  pickFolderAttachment,
  pickRemoteAttachment,
  pickRemoteFolderAttachment,
  stageAttachmentFromBlob,
  stageAttachmentFromPath
} from './attachments'

const { openDialog, readCapped } = vi.hoisted(() => ({ openDialog: vi.fn(), readCapped: vi.fn() }))

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: openDialog }))
// The capped reader is the Rust seam (`read_capped_file_base64`); the cap itself
// is pinned by store/data-url-read-max.test.ts. Here it stands in for the disk.
vi.mock('@/store/data-url-read-max', () => ({
  $dataUrlReadMaxMb: { get: () => 16 },
  dataUrlReadMaxBytes: (maxMb: number) => maxMb * 1024 * 1024,
  readCappedFileBase64: readCapped
}))
vi.mock('@/store/chat', () => ({ ensureSession: vi.fn() }))
vi.mock('@/store/gateway', () => ({ requestGateway: vi.fn() }))
// A session with a STORED id dispatches through MJXHRM-480's router, so an
// attachment reaches the gateway that owns the session rather than whichever one
// the window happens to be pointed at (MJXHRM-446 made those two different
// things). Only the draft path — no stored id yet — still goes direct.
vi.mock('@/store/session-request-router', () => ({ requestForSession: vi.fn() }))
vi.mock('@/store/session-state-types', () => ({
  $sessionStates: { get: () => ({ 'live-1': { runtimeSessionId: 'live-1', storedSessionId: 'stored-1' } }) },
  runtimeKeyForStoredSession: (storedId: string) => (storedId === 'stored-1' ? 'live-1' : null)
}))
vi.mock('@/store/notifications', () => ({ notifyError: vi.fn() }))
// Stale-runtime recovery reaches store/session -> lib/api -> store/connection,
// which subscribes to `$gatewayState` at import. Stub the seam: these cases are
// about ref shapes, and the wrapper has its own suite.
vi.mock('@/store/session-recovery', () => ({
  withSessionNotFoundResume: async (sessionId: string, _storedId: unknown, call: (id: string) => Promise<unknown>) => ({
    recovered: false,
    result: await call(sessionId),
    sessionId
  })
}))
vi.mock('@/lib/desktop-fs', () => ({ selectRemotePaths: vi.fn(async () => []) }))

describe('remote attachment picks', () => {
  beforeEach(() => {
    vi.mocked(selectRemotePaths).mockReset().mockResolvedValue([])
  })

  it('stages a backend file pick as a raw @file: ref', async () => {
    vi.mocked(selectRemotePaths).mockResolvedValueOnce(['/work/repo/src/main.ts'])

    await expect(pickRemoteAttachment('/work/repo')).resolves.toEqual({
      name: 'main.ts',
      ref: '@file:/work/repo/src/main.ts'
    })
    expect(selectRemotePaths).toHaveBeenCalledWith({ defaultPath: '/work/repo' })
  })

  it('stages a backend folder pick as a raw @folder: ref', async () => {
    vi.mocked(selectRemotePaths).mockResolvedValueOnce(['/work/repo/docs'])

    await expect(pickRemoteFolderAttachment('/work/repo')).resolves.toEqual({
      name: 'docs',
      ref: '@folder:/work/repo/docs'
    })
    expect(selectRemotePaths).toHaveBeenCalledWith({ defaultPath: '/work/repo', directories: true })
  })

  it('returns null when the picker is cancelled', async () => {
    await expect(pickRemoteAttachment()).resolves.toBeNull()
    await expect(pickRemoteFolderAttachment()).resolves.toBeNull()
  })
})

// The reference grammar (agent/context_references.py, mirrored by
// components/assistant-ui/reference-kinds) falls back to `\S+` for an UNQUOTED
// value, so a path with a space is cut at the space: `@folder:/srv/my code`
// resolves `/srv/my` — a directory that plausibly exists — and leaves ` code`
// in the prompt as prose. Wrong folder, no error. Every ref we mint must quote
// the way the gateway's own `file.attach` already does.
describe('picked paths with spaces', () => {
  beforeEach(() => {
    vi.mocked(selectRemotePaths).mockReset().mockResolvedValue([])
    openDialog.mockReset()
  })

  it('quotes a backend file pick', async () => {
    vi.mocked(selectRemotePaths).mockResolvedValueOnce(['/srv/my code/main.ts'])

    await expect(pickRemoteAttachment()).resolves.toEqual({
      name: 'main.ts',
      ref: '@file:`/srv/my code/main.ts`'
    })
  })

  it('quotes a backend folder pick', async () => {
    vi.mocked(selectRemotePaths).mockResolvedValueOnce(['/srv/my code'])

    await expect(pickRemoteFolderAttachment()).resolves.toEqual({
      name: 'my code',
      ref: '@folder:`/srv/my code`'
    })
  })

  it('quotes a local folder pick', async () => {
    openDialog.mockResolvedValueOnce('/home/me/my code')

    await expect(pickFolderAttachment()).resolves.toEqual({
      name: 'my code',
      ref: '@folder:`/home/me/my code`'
    })
  })

  it('leaves a space-free path bare', async () => {
    vi.mocked(selectRemotePaths).mockResolvedValueOnce(['/srv/work/main.ts'])

    await expect(pickRemoteAttachment()).resolves.toEqual({
      name: 'main.ts',
      ref: '@file:/srv/work/main.ts'
    })
  })
})

// Staging is the one attach path that can fail AFTER the user has committed to
// a file. It used to answer null for both "cancelled" and "failed", so an
// unreadable file or a gateway that staged nothing produced no chip and no
// message — the turn then went out as if nothing had been attached.
describe('staging failures are reported', () => {
  beforeEach(() => {
    vi.mocked(notifyError).mockReset()
    vi.mocked(ensureSession).mockResolvedValue({ id: 'live-1', storedId: 'stored-1' } as never)
    readCapped.mockReset().mockResolvedValue('AQID')
    vi.mocked(requestGateway).mockReset()
    vi.mocked(requestForSession).mockReset()
  })

  it('raises a notification when the file cannot be read', async () => {
    readCapped.mockRejectedValueOnce(new Error('permission denied'))

    await expect(stageAttachmentFromPath('/work/secret.bin')).resolves.toBeNull()
    expect(notifyError).toHaveBeenCalledWith(expect.any(Error), expect.stringContaining('secret.bin'))
  })

  // The cap is enforced in Rust, so from here a refusal is just a rejection —
  // what matters is that it never reaches `file.attach`. Staging an oversized
  // file anyway is the failure this whole change exists to prevent: on Android
  // the base64 of it is what kills the process.
  it('never sends a file the capped reader refused', async () => {
    readCapped.mockRejectedValueOnce(new Error('Bigger than the 16 MB limit. Raise it in Settings → Chat.'))

    await expect(stageAttachmentFromPath('/work/huge.png')).resolves.toBeNull()
    expect(requestForSession).not.toHaveBeenCalled()
    expect(notifyError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('16 MB') }),
      expect.stringContaining('huge.png')
    )
  })

  // Regression for the shape swap: the reader now hands back BASE64, not bytes.
  // A stray `btoa` over it would double-encode and the gateway would stage
  // garbage that still looked like a successful attach.
  it('wraps the reader base64 in a data URL exactly once', async () => {
    readCapped.mockResolvedValueOnce('AQID')
    vi.mocked(requestForSession).mockResolvedValue({ ref_text: '@file:blob.png' } as never)

    await stageAttachmentFromPath('/work/blob.png')

    const [, params] = vi.mocked(requestForSession).mock.calls[0].slice(1) as [string, Record<string, unknown>]
    expect(params.data_url).toBe('data:image/png;base64,AQID')
  })

  it('raises a notification when the gateway answers without a ref', async () => {
    vi.mocked(requestForSession).mockResolvedValue({} as never)

    await expect(stageAttachmentFromPath('/work/notes.txt')).resolves.toBeNull()
    expect(notifyError).toHaveBeenCalledWith(expect.any(Error), expect.stringContaining('notes.txt'))
  })

  it('stays quiet when the gateway does hand back a ref', async () => {
    vi.mocked(requestForSession).mockResolvedValue({ ref_text: '@file:notes.txt' } as never)

    await expect(stageAttachmentFromPath('/work/notes.txt')).resolves.toEqual({
      name: 'notes.txt',
      ref: '@file:notes.txt'
    })
    expect(notifyError).not.toHaveBeenCalled()
  })
})

// Bytes with no path: a pasted or dropped screenshot. The composer has always
// pulled image blobs off the paste event and always called `preventDefault()` on
// them, but universal never passed it a handler — so the bytes were swallowed
// and nothing appeared (MJXHRM-415). `file.attach` takes `data_url` OR `path`
// (methods_prompt.py errors only when both are missing), which is what makes a
// blob a first-class attachment rather than a lesser one.
describe('staging bytes that never had a path', () => {
  beforeEach(() => {
    vi.mocked(notifyError).mockReset()
    vi.mocked(ensureSession).mockResolvedValue({ id: 'live-1', storedId: 'stored-1' } as never)
    vi.mocked(requestGateway).mockReset()
    vi.mocked(requestForSession).mockReset()
  })

  it('uploads the blob as a data URL with NO path and returns the ref', async () => {
    vi.mocked(requestForSession).mockResolvedValue({ ref_text: '@image:shot.png' } as never)

    await expect(
      stageAttachmentFromBlob(new Blob(['\u0001\u0002'], { type: 'image/png' }), 'shot.png')
    ).resolves.toEqual({ name: 'shot.png', ref: '@image:shot.png' })

    const [method, params] = vi.mocked(requestForSession).mock.calls[0].slice(1) as [string, Record<string, unknown>]
    expect(method).toBe('file.attach')
    expect(params.name).toBe('shot.png')
    expect(params.path).toBeUndefined()
    expect(String(params.data_url)).toMatch(/^data:image\/png;base64,/)
  })

  // A clipboard blob has no filename. The extension has to come off the MIME or
  // the gateway files a screenshot as something it will not treat as an image.
  it('names an unnamed blob from its own MIME type', async () => {
    vi.mocked(requestForSession).mockResolvedValue({ ref_text: '@image:x' } as never)

    await stageAttachmentFromBlob(new Blob(['x'], { type: 'image/jpeg' }))

    const [, params] = vi.mocked(requestForSession).mock.calls[0].slice(1) as [string, Record<string, unknown>]
    expect(String(params.name)).toMatch(/^pasted-image-\d+\.jpg$/)
  })

  // A pasted blob has no path for Rust to open, so this half of the cap is the
  // webview's. Base64 still expands it by a third on the way to a gateway frame,
  // and a 400 MB screenshot buffer is as fatal on a phone as a 400 MB file.
  it('refuses a pasted blob over the cap, naming the limit', async () => {
    const huge = new Blob(['x'], { type: 'image/png' })
    Object.defineProperty(huge, 'size', { value: 17 * 1024 * 1024 })

    await expect(stageAttachmentFromBlob(huge, 'huge.png')).resolves.toBeNull()
    expect(requestForSession).not.toHaveBeenCalled()
    expect(notifyError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('16') }),
      expect.stringContaining('huge.png')
    )
  })

  // The disagreeing neighbour of the case above: one MB under the same cap has
  // to still attach, or the guard would read as green while blocking everything.
  it('stages a pasted blob just under the cap', async () => {
    vi.mocked(requestForSession).mockResolvedValue({ ref_text: '@image:ok.png' } as never)

    const nearly = new Blob(['x'], { type: 'image/png' })
    Object.defineProperty(nearly, 'size', { value: 15 * 1024 * 1024 })

    await expect(stageAttachmentFromBlob(nearly, 'ok.png')).resolves.toEqual({ name: 'ok.png', ref: '@image:ok.png' })
    expect(notifyError).not.toHaveBeenCalled()
  })

  it('reports a gateway that stages nothing, instead of dropping the paste silently', async () => {
    vi.mocked(requestForSession).mockResolvedValue({} as never)

    await expect(stageAttachmentFromBlob(new Blob(['x'], { type: 'image/png' }), 'shot.png')).resolves.toBeNull()
    expect(notifyError).toHaveBeenCalledWith(expect.any(Error), expect.stringContaining('shot.png'))
  })
})

// `attachToSession` (MJXHRM-445 §2.3 A-5) — staging into a session that is NOT
// the one on screen. The composer's stagers resolve `ensureSession()`; a room
// fanning one file out to six member sessions must not, or all six copies land
// in the user's own chat.
describe('attachToSession targets the session it is given', () => {
  beforeEach(() => {
    vi.mocked(notifyError).mockReset()
    vi.mocked(requestGateway).mockReset()
    vi.mocked(requestForSession).mockReset()
    vi.mocked(ensureSession).mockReset()
  })

  it('routes by the GIVEN stored id and never resolves the active session', async () => {
    vi.mocked(requestForSession).mockResolvedValue({ ref_text: '@image:plan.png' } as never)

    await expect(
      attachToSession('stored-member-3', { dataUrl: 'data:image/png;base64,AQID', name: 'plan.png' })
    ).resolves.toEqual({ name: 'plan.png', ref: '@image:plan.png' })

    // The whole point: nothing asked what the user is looking at.
    expect(ensureSession).not.toHaveBeenCalled()

    const [storedId, method, params] = vi.mocked(requestForSession).mock.calls[0] as [
      string,
      string,
      Record<string, unknown>
    ]

    expect(storedId).toBe('stored-member-3')
    expect(method).toBe('file.attach')
    expect(params.name).toBe('plan.png')
  })

  it('sends the session runtime id when one is known, and the stored id otherwise', async () => {
    vi.mocked(requestForSession).mockResolvedValue({ ref_text: '@image:a' } as never)

    // `stored-1` has a live slice in the mocked map above.
    await attachToSession('stored-1', { dataUrl: 'data:image/png;base64,AQID', name: 'a.png' })
    expect((vi.mocked(requestForSession).mock.calls[0][2] as Record<string, unknown>).session_id).toBe('live-1')

    // A member this window has never bound has no runtime id to send.
    await attachToSession('stored-cold', { dataUrl: 'data:image/png;base64,AQID', name: 'b.png' })
    expect((vi.mocked(requestForSession).mock.calls[1][2] as Record<string, unknown>).session_id).toBe('stored-cold')
  })

  it('carries the owning profile through, so a member on another agent is reached', async () => {
    vi.mocked(requestForSession).mockResolvedValue({ ref_text: '@image:a' } as never)

    await attachToSession('stored-cold', { dataUrl: 'data:x', name: 'a.png', profile: 'radar' })

    expect(vi.mocked(requestForSession).mock.calls[0][4]).toBe('radar')
  })

  it('reports a staging failure rather than answering a silent null', async () => {
    vi.mocked(requestForSession).mockResolvedValue({} as never)

    await expect(attachToSession('stored-1', { dataUrl: 'data:x', name: 'a.png' })).resolves.toBeNull()
    expect(notifyError).toHaveBeenCalledWith(expect.any(Error), expect.stringContaining('a.png'))
  })
})
