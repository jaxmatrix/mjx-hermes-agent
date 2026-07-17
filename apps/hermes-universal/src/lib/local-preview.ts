// STUB — desktop's local-preview resolves a path/URL into a rich preview target
// (local file read vs remote fs facade vs localhost dev server) for the preview
// pane. Universal's preview store is a leaner tab model, so this returns just the
// target descriptor; setCurrentSessionPreviewTarget (store/preview) opens the tab.
// FLAG(chat-port): no local byte-reading / dev-server detection yet.

export interface LocalPreviewTarget {
  target: string
  dataUrl?: string
  previewKind?: 'image'
  [key: string]: unknown
}

export async function normalizeOrLocalPreviewTarget(
  target: string,
  _cwd?: string
): Promise<LocalPreviewTarget | null> {
  const trimmed = target.trim()

  return trimmed ? { target: trimmed } : null
}
