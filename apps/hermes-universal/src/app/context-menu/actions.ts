import { closeContextMenu } from '@/app/context-menu/store'
import type { ContextMenuDomTarget } from '@/app/context-menu/target'
import { readClipboardText, writeClipboardText } from '@/lib/clipboard'
import { gatewayMediaDataUrl, mediaMime, mediaName } from '@/lib/media'

// The non-UI half of the menu: everything an item DOES, with no React and no
// menu in sight. Identical on all five platforms by design — that is the
// guarantee any future mobile menu shape sits on (rule 35).

export type EditableCommand = 'copy' | 'cut' | 'paste' | 'selectAll'

const MIME_EXTENSIONS: Record<string, string> = {
  'image/gif': '.gif',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/svg+xml': '.svg',
  'image/webp': '.webp'
}

let composing = false

/**
 * Track a live IME preedit.
 *
 * Cut and paste must not run mid-composition: splicing the field's value while
 * the engine holds an uncommitted preedit corrupts the buffer, and for a CJK
 * typist every ASCII run goes through composition. The coordinator feeds this
 * from window-level `compositionstart` / `compositionend`.
 */
export function noteComposition(active: boolean): void {
  composing = active
}

export function isComposing(): boolean {
  return composing
}

/**
 * Close the menu, then act — on the NEXT frame, with focus back on the field.
 *
 * A Radix content is a focus trap: a `focus()` while it is open is stolen
 * straight back and the command runs against `<body>`, which is how "select
 * all" ends up selecting the whole transcript instead of the composer. The rAF
 * is not a hedge, it is the ordering the trap requires.
 */
export function withEditableFocus(editable: HTMLElement | null, action: () => void): void {
  closeContextMenu()
  requestAnimationFrame(() => {
    editable?.focus()
    action()
  })
}

function formFieldOf(editable: HTMLElement | null): HTMLInputElement | HTMLTextAreaElement | null {
  return editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement ? editable : null
}

/**
 * Write through the prototype's native `value` setter.
 *
 * React installs its own descriptor on the instance and tracks the last value it
 * wrote; assigning `field.value` directly updates the DOM but leaves the tracker
 * agreeing, so the synthetic `input` event is swallowed and controlled state
 * never sees the edit. Cut and paste both depend on this.
 */
function setFieldValue(field: HTMLInputElement | HTMLTextAreaElement, value: string, caret: number): void {
  const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set

  if (setter) {
    setter.call(field, value)
  } else {
    field.value = value
  }

  field.setSelectionRange(caret, caret)
  field.dispatchEvent(new Event('input', { bubbles: true }))
}

function replaceFieldSelection(field: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  const start = field.selectionStart ?? field.value.length
  const end = field.selectionEnd ?? start

  setFieldValue(field, field.value.slice(0, start) + text + field.value.slice(end), start + text.length)
}

/** The text a copy/cut would take, or `''` when nothing is selected. */
export function editableSelectionText(target: ContextMenuDomTarget): string {
  const field = formFieldOf(target.editable)

  if (!field) {
    return target.selectionText
  }

  // An `<input>`'s selection is NEVER in `window.getSelection()` — it lives on
  // the element, and reading the document selection here returns the empty
  // string for a field with text highlighted in it.
  return field.value.slice(field.selectionStart ?? 0, field.selectionEnd ?? 0)
}

/**
 * Select all INSIDE the field.
 *
 * A DOM `Range` confined to the element cannot escape it, which is the whole
 * point: desktop learned the hard way that a main-process `selectAll` (and
 * `document.execCommand('selectAll')` with focus anywhere else) grabs the
 * transcript instead.
 */
export function selectAllInEditable(editable: HTMLElement | null): void {
  const field = formFieldOf(editable)

  if (field) {
    field.select()

    return
  }

  if (!editable) {
    return
  }

  const selection = window.getSelection()
  const range = document.createRange()

  range.selectNodeContents(editable)
  selection?.removeAllRanges()
  selection?.addRange(range)
}

/** Run one edit verb against the clicked field, renderer-scoped on every platform. */
export async function editableCommand(command: EditableCommand, target: ContextMenuDomTarget): Promise<void> {
  const field = formFieldOf(target.editable)

  if (command === 'selectAll') {
    selectAllInEditable(target.editable)

    return
  }

  if (command === 'copy' || command === 'cut') {
    const text = editableSelectionText(target)

    if (!text) {
      return
    }

    await writeClipboardText(text)

    if (command === 'cut' && !composing) {
      if (field) {
        replaceFieldSelection(field, '')
      } else {
        window.getSelection()?.deleteFromDocument()
      }
    }

    return
  }

  if (composing) {
    return
  }

  const text = await readClipboardText()

  if (!text) {
    return
  }

  if (field) {
    replaceFieldSelection(field, text)

    return
  }

  // The one place `execCommand` is genuinely the right tool: it is undoable and
  // IME-safe, and no Range-based insert in a contenteditable is either.
  if (!document.execCommand('insertText', false, text)) {
    const selection = window.getSelection()

    selection?.deleteFromDocument()
    selection?.getRangeAt(0)?.insertNode(document.createTextNode(text))
  }
}

function extensionForMime(mime: string): string {
  return MIME_EXTENSIONS[mime.toLowerCase()] ?? ''
}

function dataUrlMime(url: string): string {
  return url.startsWith('data:') ? url.slice(5, Math.max(5, url.search(/[;,]/))) : ''
}

/**
 * A filename for "Save image as…" that ALWAYS carries an extension.
 *
 * Generated-image URLs (fal.media and friends) end in an extensionless content
 * hash, and a file saved without one is an unopenable "All Files" blob on
 * Windows. The extension comes from the `data:` MIME when there is one, from the
 * path otherwise, and falls back to `.png` — never to nothing.
 */
export function imageFileName(src: string, fallback = ''): string {
  const mime = dataUrlMime(src)
  // A `data:` URL has no name — its "last path segment" is the base64 payload,
  // which would make a megabyte-long filename the picker cannot show.
  const base = (fallback || (mime ? '' : mediaName(src)) || 'image').replace(/[/\\]/g, '_')

  if (/\.[a-z0-9]{2,5}$/i.test(base)) {
    return base
  }

  return `${base}${extensionForMime(mime) || (mime ? '' : extensionForMime(mediaMime(src))) || '.png'}`
}

/**
 * The image's bytes as a `data:` URL.
 *
 * Under `img-src 'self' data:` an image that RENDERED is already either a data
 * URL or an app asset, so the common case is a pass-through. A gateway path that
 * was never resolved goes through the same authenticated fs bridge the transcript
 * uses — in the WEBVIEW, because Rust has no gateway base URL of its own (rule 3).
 */
export async function imageDataUrl(src: string): Promise<string> {
  if (!src) {
    throw new Error('image has no source')
  }

  return src.startsWith('data:') ? src : gatewayMediaDataUrl(src)
}

/**
 * Re-encode to PNG in the webview when the source is not already one.
 *
 * `tauri::image::Image::from_bytes` decodes PNG and nothing else, and adding an
 * image-codec crate to Rust to cover a JPEG the webview has ALREADY decoded
 * would be the expensive way round. A `data:` source never taints the canvas,
 * so this is legal exactly where it is needed.
 */
export async function pngDataUrl(dataUrl: string, element: HTMLImageElement | null): Promise<string> {
  if (dataUrlMime(dataUrl) === 'image/png') {
    return dataUrl
  }

  const source = element?.complete && element.naturalWidth > 0 ? element : await decodeImage(dataUrl)
  const canvas = document.createElement('canvas')

  canvas.width = source.naturalWidth
  canvas.height = source.naturalHeight

  const context = canvas.getContext('2d')

  if (!context) {
    throw new Error('canvas unavailable')
  }

  context.drawImage(source, 0, 0)

  return canvas.toDataURL('image/png')
}

function decodeImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()

    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('image could not be decoded'))
    image.src = dataUrl
  })
}

async function invokeContextMenu<T>(command: string, args: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')

  return invoke<T>(command, args)
}

/** Copy the image to the system clipboard as PNG bytes, through Rust. */
export async function copyImageFrom(src: string, element: HTMLImageElement | null): Promise<void> {
  const png = await pngDataUrl(await imageDataUrl(src), element)

  await invokeContextMenu('context_menu_copy_image', { source: { kind: 'data', value: png } })
}

/**
 * Ask for a path, then write the ORIGINAL bytes there through Rust.
 *
 * Original, not the PNG re-encode: a JPEG the user saves should still be a JPEG.
 * Rust does the write because `capabilities/default.json` grants no binary file
 * write and no clipboard image write, and widening either would widen the ACL
 * for every window label — our own commands need no entry at all.
 *
 * Returns the written path, or `null` when the picker was cancelled.
 */
export async function saveImageFrom(src: string): Promise<null | string> {
  const dataUrl = await imageDataUrl(src)
  const { save } = await import('@tauri-apps/plugin-dialog')
  const path = await save({ defaultPath: imageFileName(src) })

  if (!path) {
    return null
  }

  return invokeContextMenu<string>('context_menu_save_image', {
    path,
    source: { kind: 'data', value: dataUrl }
  })
}
