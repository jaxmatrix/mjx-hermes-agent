/**
 * Image / paste writes over Rust `composer_paste` — Electron `saveImageBuffer`,
 * `savePastedText`, `saveClipboardImage`, plus `saveImageFromUrl` (OS save dialog
 * via the context-menu path).
 *
 * Binary payloads cross IPC as base64 (same reason as `read_capped_file_base64`:
 * a `Uint8Array` would serialise as a number array).
 */

type Bridge = NonNullable<typeof window.hermesDesktop>

async function invokeNative<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')

  return invoke<T>(command, args)
}

function bytesToBase64(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  let binary = ''
  const chunk = 0x8000

  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }

  return btoa(binary)
}

const saveImageFromUrl: Bridge['saveImageFromUrl'] = async url => {
  // Dynamic: the context menu's actions reach its store and the clipboard seam.
  const { saveImageFrom } = await import('@/app/context-menu/actions')

  return (await saveImageFrom(String(url || ''))) !== null
}

const saveImageBuffer: Bridge['saveImageBuffer'] = async (data, ext, name) =>
  invokeNative('save_image_buffer', {
    dataBase64: bytesToBase64(data),
    ext,
    name: name ?? null
  })

const savePastedText: Bridge['savePastedText'] = async text =>
  invokeNative('save_pasted_text', { text: String(text ?? '') })

const saveClipboardImage: Bridge['saveClipboardImage'] = async () => invokeNative('save_clipboard_image')

export const imagesBridge: Pick<
  Bridge,
  'saveClipboardImage' | 'saveImageBuffer' | 'saveImageFromUrl' | 'savePastedText'
> = {
  saveClipboardImage,
  saveImageBuffer,
  saveImageFromUrl,
  savePastedText
}
