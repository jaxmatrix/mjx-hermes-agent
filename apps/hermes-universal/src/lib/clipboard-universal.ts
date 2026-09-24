/**
 * Clipboard image reads for the composer (Tauri plugin / desktop bridge).
 * AUTO `lib/clipboard.ts` only installs the write shim.
 */

export function canReadClipboardImage(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

export async function readClipboardImage(): Promise<Blob | null> {
  try {
    const { readImage } = await import('@tauri-apps/plugin-clipboard-manager')
    const image = await readImage()
    const rgba = await image.rgba()

    return rgba.byteLength > 0 ? new Blob([new Uint8Array(rgba)], { type: 'image/png' }) : null
  } catch {
    return null
  }
}
