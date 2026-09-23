/**
 * `saveImageFromUrl`: "Save image as…", over the context menu's own save
 * (`app/context-menu/actions.ts` → the OS save dialog, then
 * `context_menu_save_image`, which writes the ORIGINAL bytes in Rust).
 *
 * Electron fetches an `https:` source in the main process. Here an image that
 * rendered is already a `data:` URL or a file path — `img-src 'self' data:`
 * admits nothing else — so those are the two sources `imageDataUrl` reads, and
 * anything else rejects rather than saving nothing.
 *
 * Electron's answer: `true` written, `false` when the dialog was dismissed.
 */

type Bridge = NonNullable<typeof window.hermesDesktop>

const saveImageFromUrl: Bridge['saveImageFromUrl'] = async url => {
  // Dynamic: the context menu's actions reach its store and the clipboard seam.
  const { saveImageFrom } = await import('@/app/context-menu/actions')

  return (await saveImageFrom(String(url || ''))) !== null
}

export const imagesBridge: Pick<Bridge, 'saveImageFromUrl'> = { saveImageFromUrl }
