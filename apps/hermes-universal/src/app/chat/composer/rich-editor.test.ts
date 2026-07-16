import { describe, expect, it } from 'vitest'

import {
  composerPlainText,
  deleteSelectionInEditor,
  insertPlainTextAtCaret,
  normalizeComposerEditorDom,
  refChipElement,
  renderComposerContents,
  RICH_INPUT_SLOT
} from './rich-editor'

// Ported (subset) from apps/desktop/src/app/chat/composer/rich-editor.test.ts —
// the inline-refs cases (a desktop-only helper) are dropped.

const makeEditor = () => {
  const editor = document.createElement('div')
  editor.dataset.slot = RICH_INPUT_SLOT
  document.body.append(editor)
  return editor
}

const caretAtEnd = (editor: HTMLElement) => {
  const range = document.createRange()
  const selection = window.getSelection()!
  range.selectNodeContents(editor)
  range.collapse(false)
  selection.removeAllRanges()
  selection.addRange(range)
}

describe('renderComposerContents', () => {
  it('renders refs + raw text without interpreting user text as HTML', () => {
    const editor = makeEditor()
    renderComposerContents(editor, '@file:`<img src=x onerror=alert(1)>` <b>raw</b>')

    expect(editor.querySelector('img')).toBeNull()
    expect(editor.querySelector('b')).toBeNull()
    expect(editor.textContent).toContain('<b>raw</b>')
    expect(composerPlainText(editor)).toBe('@file:`<img src=x onerror=alert(1)>` <b>raw</b>')
  })

  it('round-trips a chip + trailing text', () => {
    const editor = makeEditor()
    renderComposerContents(editor, 'see @file:`src/foo.ts` please')
    expect(editor.querySelector('[data-ref-text]')).not.toBeNull()
    expect(composerPlainText(editor)).toBe('see @file:`src/foo.ts` please')
  })
})

describe('normalizeComposerEditorDom', () => {
  it('unwraps a single wrapper div so plain text stays one line', () => {
    const editor = makeEditor()
    editor.innerHTML = '<div><span data-ref-text="@file:`src/foo.ts`" contenteditable="false">foo.ts</span> </div>'
    normalizeComposerEditorDom(editor)
    expect(composerPlainText(editor)).toBe('@file:`src/foo.ts` ')
    expect(editor.querySelector(':scope > div')).toBeNull()
  })

  it('removes a trailing br after a ref chip', () => {
    const editor = makeEditor()
    editor.append(refChipElement('file', '`src/foo.ts`'), document.createElement('br'))
    normalizeComposerEditorDom(editor)
    expect(composerPlainText(editor)).toBe('@file:`src/foo.ts`')
    expect(editor.querySelector('br')).toBeNull()
  })
})

describe('insertPlainTextAtCaret + deleteSelectionInEditor', () => {
  it('inserts plain text at the caret, preserving newlines as <br>', () => {
    const editor = makeEditor()
    caretAtEnd(editor)
    insertPlainTextAtCaret(editor, 'line one\nline two')
    expect(composerPlainText(editor)).toBe('line one\nline two')
  })

  it('deletes a non-collapsed selection', () => {
    const editor = makeEditor()
    renderComposerContents(editor, 'hello world')
    const range = document.createRange()
    range.selectNodeContents(editor)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    expect(deleteSelectionInEditor(editor)).toBe(true)
    expect(composerPlainText(editor)).toBe('')
  })
})
