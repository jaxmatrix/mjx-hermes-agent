import { atom } from '@/store/atom'

// Ported from desktop's store/preview-edit.ts. Tracks which open files have
// unsaved edits, keyed by absolute path — the tab strip reads this to show the
// amber "modified" dot; the preview-file editor is the sole writer.
export const $dirtyPreviewPaths = atom<Set<string>>(new Set())

export function setPreviewDirty(path: string, dirty: boolean): void {
  const current = $dirtyPreviewPaths.get()
  const has = current.has(path)

  if (dirty === has) {
    return
  }

  const next = new Set(current)

  if (dirty) {
    next.add(path)
  } else {
    next.delete(path)
  }

  $dirtyPreviewPaths.set(next)
}
