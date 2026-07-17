import { atom, computed } from '@/store/atom'

// The right-pane file viewer/editor's open-file state. Adapted (much simplified)
// from desktop's store/preview.ts: a VS Code-style set of file tabs + the active
// one. Desktop's target also modeled web/URL previews (Electron webview) and a
// per-session registry — dropped here; this is files only.

export interface PreviewTarget {
  /** Absolute file path — the tab id. */
  path: string
  /** Basename, for the tab label. */
  name: string
}

function baseName(path: string): string {
  const cleaned = path.replace(/[\\/]+$/, '')
  return cleaned.slice(cleaned.lastIndexOf('/') + 1) || cleaned
}

export const $previewTabs = atom<PreviewTarget[]>([])
export const $activePreviewPath = atom<string | null>(null)
/** Bumped to force the active file to re-read from disk (after a save). */
export const $previewReloadNonce = atom(0)

export const $activePreviewTarget = computed(
  [$previewTabs, $activePreviewPath],
  (tabs, active) => tabs.find(tab => tab.path === active) ?? null
)

export function setPreviewTarget(path: string): void {
  const tabs = $previewTabs.get()
  if (!tabs.some(tab => tab.path === path)) {
    $previewTabs.set([...tabs, { name: baseName(path), path }])
  }
  $activePreviewPath.set(path)
}

export function selectPreviewTab(path: string): void {
  if ($previewTabs.get().some(tab => tab.path === path)) $activePreviewPath.set(path)
}

// Opened from a composer attachment pill (ported from desktop, where it set a
// rich session-scoped preview target). Universal's preview model is tab-based,
// so this best-effort opens a tab for the target's path. The rich preview
// descriptor + source are accepted for import-site parity but not yet used.
// FLAG(chat-port).
export function setCurrentSessionPreviewTarget(
  preview: { target?: unknown } & Record<string, unknown>,
  _source: string,
  target: string
): void {
  const path = target || (typeof preview.target === 'string' ? preview.target : '')
  if (path) setPreviewTarget(path)
}

export function requestPreviewReload(): void {
  $previewReloadNonce.set($previewReloadNonce.get() + 1)
}

function afterClose(remaining: PreviewTarget[], closed: string): void {
  $previewTabs.set(remaining)
  if ($activePreviewPath.get() === closed) {
    $activePreviewPath.set(remaining.length ? remaining[remaining.length - 1].path : null)
  }
}

export function closePreviewTab(path: string): void {
  afterClose(
    $previewTabs.get().filter(tab => tab.path !== path),
    path
  )
}

export function closeOtherPreviewTabs(path: string): void {
  const keep = $previewTabs.get().filter(tab => tab.path === path)
  $previewTabs.set(keep)
  $activePreviewPath.set(keep.length ? path : null)
}

export function closeAllPreviewTabs(): void {
  $previewTabs.set([])
  $activePreviewPath.set(null)
}
