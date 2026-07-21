import { type Codec, persistentAtom } from '@/lib/persisted'
import { IS_TAURI } from '@/lib/platform'

// UI scale via the Tauri webview zoom factor. Mirrors the desktop `store/zoom.ts`
// but applies zoom through Tauri (`webview.setZoom`) instead of Electron IPC.
// Persisted per-device.

export const ZOOM_MIN = 50
export const ZOOM_MAX = 200

const numberCodec: Codec<number> = {
  decode: raw => {
    const n = Number(raw)

    return Number.isFinite(n) ? n : 100
  },
  encode: value => String(value)
}

export const $zoomPercent = persistentAtom<number>('hermes.zoomPercent', 100, numberCodec)

/** Apply a zoom percent to the live webview (no-op off Tauri / on failure). */
export async function applyZoom(percent: number): Promise<void> {
  if (!IS_TAURI) {
    return
  }

  try {
    const { getCurrentWebview } = await import('@tauri-apps/api/webview')
    await getCurrentWebview().setZoom(percent / 100)
  } catch {
    // WebviewGTK/platform may not support it — cosmetic, never surface.
  }
}

export function setZoomPercent(percent: number): void {
  const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(percent)))
  $zoomPercent.set(clamped)
  void applyZoom(clamped)
}

/** Nudge zoom by a step (Cmd/Ctrl +/-). */
export function bumpZoom(deltaPercent: number): void {
  setZoomPercent($zoomPercent.get() + deltaPercent)
}

/** Apply the persisted zoom once at startup. */
export function initZoom(): void {
  void applyZoom($zoomPercent.get())
}
