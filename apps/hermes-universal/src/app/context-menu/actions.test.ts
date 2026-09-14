/**
 * The verbs, which are the same on all five platforms by design.
 *
 * Two of them carry a bug's worth of history: `selectAllInEditable` uses a
 * `Range` confined to the element because desktop's main-process `selectAll`
 * escaped the field and grabbed the transcript, and the edit verbs write through
 * the prototype's native `value` setter because React's own descriptor swallows
 * a plain assignment's `input` event and controlled state never sees the edit.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const clipboard = { readClipboardText: vi.fn(async () => ''), writeClipboardText: vi.fn(async () => undefined) }

vi.mock('@/lib/clipboard', () => clipboard)

const { editableCommand, editableSelectionText, imageFileName, noteComposition, selectAllInEditable, withEditableFocus } =
  await import('./actions')

const { resolveDomTarget } = await import('./target')

function mount(html: string): HTMLElement {
  document.body.innerHTML = html

  return document.body.firstElementChild as HTMLElement
}

beforeEach(() => {
  clipboard.readClipboardText.mockReset().mockResolvedValue('')
  clipboard.writeClipboardText.mockReset().mockResolvedValue(undefined)
  noteComposition(false)
})

afterEach(() => {
  document.body.innerHTML = ''
  window.getSelection()?.removeAllRanges()
})

describe('imageFileName', () => {
  it('forces an extension on an extensionless generated-image URL', () => {
    // A file saved without one is an unopenable "All Files" blob on Windows —
    // the bug this function exists for.
    expect(imageFileName('https://fal.media/files/9f3ac1d0e5')).toBe('9f3ac1d0e5.png')
  })

  it('takes the extension from the data: MIME when there is one', () => {
    expect(imageFileName('data:image/webp;base64,AA')).toBe('image.webp')
    expect(imageFileName('data:image/jpeg;base64,AA', 'shot')).toBe('shot.jpg')
  })

  it('takes it from the path when the source is a gateway file', () => {
    expect(imageFileName('/workspace/out/diagram.svg')).toBe('diagram.svg')
    expect(imageFileName('/workspace/out/diagram')).toBe('diagram.png')
  })

  it('never returns a base64 payload as a filename', () => {
    const name = imageFileName(`data:image/png;base64,${'A'.repeat(500)}`)

    expect(name).toBe('image.png')
  })
})

describe('selectAllInEditable', () => {
  it('selects the field, not the document, for a form field', () => {
    const field = mount('<textarea>draft text</textarea>') as HTMLTextAreaElement

    selectAllInEditable(field)

    expect([field.selectionStart, field.selectionEnd]).toEqual([0, 'draft text'.length])
  })

  it('confines the range to a contenteditable — the transcript above stays unselected', () => {
    document.body.innerHTML = '<article>transcript text</article><div contenteditable="true">draft</div>'

    const editable = document.querySelector('[contenteditable]') as HTMLElement

    selectAllInEditable(editable)

    const selection = window.getSelection()

    expect(selection?.toString()).toBe('draft')
    // The range never escapes the field — that is the invariant, not the text.
    expect(editable.contains(selection?.getRangeAt(0).commonAncestorContainer ?? null)).toBe(true)
  })
})

describe('editableCommand', () => {
  it('cut copies the field selection and fires a native-setter input event', async () => {
    const field = mount('<textarea>hello world</textarea>') as HTMLTextAreaElement
    const seen: string[] = []

    field.setSelectionRange(6, 11)
    field.addEventListener('input', () => seen.push(field.value))

    await editableCommand('cut', resolveDomTarget(field))

    expect(clipboard.writeClipboardText).toHaveBeenCalledWith('world')
    expect(field.value).toBe('hello ')
    // The event is what a controlled composer's send-button state hangs off.
    expect(seen).toEqual(['hello '])
  })

  it('reads an input’s selection off the ELEMENT, not off window.getSelection()', () => {
    const field = mount('<input type="text" value="hello world">') as HTMLInputElement

    field.setSelectionRange(0, 5)

    // jsdom's document selection is empty here, exactly as a real browser's is.
    expect(window.getSelection()?.toString()).toBe('')
    expect(editableSelectionText(resolveDomTarget(field))).toBe('hello')
  })

  it('paste inserts at the caret', async () => {
    const field = mount('<input type="text" value="ab">') as HTMLInputElement

    clipboard.readClipboardText.mockResolvedValue('XY')
    field.setSelectionRange(1, 1)

    await editableCommand('paste', resolveDomTarget(field))

    expect(field.value).toBe('aXYb')
  })

  it('refuses to splice the buffer while an IME composition is live', async () => {
    const field = mount('<textarea>hello</textarea>') as HTMLTextAreaElement

    field.setSelectionRange(0, 5)
    noteComposition(true)
    clipboard.readClipboardText.mockResolvedValue('XY')

    await editableCommand('paste', resolveDomTarget(field))
    await editableCommand('cut', resolveDomTarget(field))

    expect(field.value).toBe('hello')
  })
})

describe('withEditableFocus', () => {
  it('closes, then focuses and acts on the NEXT frame', async () => {
    const field = mount('<textarea>draft</textarea>') as HTMLTextAreaElement
    const order: string[] = []

    field.addEventListener('focus', () => order.push('focus'))

    withEditableFocus(field, () => order.push('action'))

    // A Radix content is a focus trap: acting inline runs the verb against
    // <body> while the menu still owns focus.
    expect(order).toEqual([])

    await new Promise(resolve => requestAnimationFrame(resolve))

    expect(order).toEqual(['focus', 'action'])
    expect(document.activeElement).toBe(field)
  })
})
