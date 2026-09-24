/**
 * Electron `contextMenuEdit` / `contextMenuCopyImage` for the custom menu.
 *
 * Edit verbs run in the renderer after the menu restores focus (Electron used
 * `webContents.cut/copy/paste`). Image copy resolves the `<img>` under the last
 * contextmenu point and hands PNG bytes to Rust `context_menu_copy_image` —
 * Tauri has no `copyImageAt`.
 */

import { readClipboardText } from '@/lib/clipboard-tauri'

type Bridge = NonNullable<typeof window.hermesDesktop>

let lastContextPoint: { x: number; y: number } | null = null

if (typeof window !== 'undefined') {
  window.addEventListener(
    'contextmenu',
    event => {
      lastContextPoint = { x: event.clientX, y: event.clientY }
    },
    true
  )
}

async function invokeNative<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')

  return invoke<T>(command, args)
}

/** Re-encode to PNG data URL — same contract as the menu's image copy path. */
async function pngDataUrl(src: string, element: HTMLImageElement): Promise<string> {
  if (src.startsWith('data:image/png')) {
    return src
  }

  const canvas = document.createElement('canvas')

  canvas.width = element.naturalWidth || element.width
  canvas.height = element.naturalHeight || element.height

  const context = canvas.getContext('2d')

  if (!context) {
    throw new Error('canvas unavailable')
  }

  context.drawImage(element, 0, 0)

  return canvas.toDataURL('image/png')
}

const contextMenuEdit: NonNullable<Bridge['contextMenuEdit']> = async command => {
  if (command === 'selectAll') {
    document.execCommand('selectAll')

    return
  }

  if (command === 'copy' || command === 'cut') {
    document.execCommand(command)

    return
  }

  // `execCommand('paste')` is blocked in modern webviews; insert from the
  // clipboard the same way the menu's editable path does.
  const text = await readClipboardText()

  if (!text) {
    return
  }

  if (!document.execCommand('insertText', false, text)) {
    document.execCommand('paste')
  }
}

const contextMenuCopyImage: NonNullable<Bridge['contextMenuCopyImage']> = async () => {
  if (!lastContextPoint) {
    return
  }

  const hit = document.elementFromPoint(lastContextPoint.x, lastContextPoint.y)

  const img =
    hit instanceof HTMLImageElement ? hit : hit instanceof Element ? hit.closest('img') : null

  if (!(img instanceof HTMLImageElement)) {
    return
  }

  const src = img.currentSrc || img.src

  if (!src) {
    return
  }

  const png = await pngDataUrl(src, img)

  await invokeNative('context_menu_copy_image', { source: { kind: 'data', value: png } })
}

export const contextMenuBridge: Pick<Bridge, 'contextMenuEdit' | 'contextMenuCopyImage'> = {
  contextMenuEdit,
  contextMenuCopyImage
}

/** Test seam. */
export function __setLastContextPointForTests(point: { x: number; y: number } | null): void {
  lastContextPoint = point
}
