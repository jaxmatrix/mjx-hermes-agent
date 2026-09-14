/**
 * The open-menu atom and its two identity-guarded late facts.
 *
 * Both facts arrive AFTER the menu is on screen — the clipboard probe is an OS
 * round trip, and the native facts (v2) come from the embedder — so both can
 * resolve against a menu the user has already replaced.
 */

import { afterEach, describe, expect, it } from 'vitest'

import type { ContextGesture, ContextTargetMatch } from './registry'
import { $contextMenu, __resetContextMenu, applyClipboardProbe, applyNativeFacts, openContextMenu } from './store'

const GESTURE: ContextGesture = { element: null, source: 'mouse', x: 4, y: 8 }

function open(match: ContextTargetMatch): number {
  return openContextMenu({ gesture: GESTURE, match, source: 'mouse', x: 4, y: 8 })
}

const editableMatch: ContextTargetMatch = {
  data: { editable: document.createElement('textarea'), imageUrl: '', linkUrl: '', onImage: false, selectionText: '' },
  kind: 'dom'
}

const linkMatch: ContextTargetMatch = {
  data: { editable: null, imageUrl: '', linkUrl: 'https://example.test/', onImage: false, selectionText: '' },
  kind: 'dom'
}

afterEach(() => {
  __resetContextMenu()
})

describe('openContextMenu', () => {
  it('opens with both late facts absent — the menu paints in the gesture’s frame', () => {
    open(linkMatch)

    expect($contextMenu.get()?.clipboardHasText).toBe(false)
    expect($contextMenu.get()?.native).toBeNull()
  })

  it('replaces the open menu — two can never be open at once', () => {
    const first = open(linkMatch)
    const second = open(editableMatch)

    expect(second).not.toBe(first)
    expect($contextMenu.get()?.id).toBe(second)
    expect($contextMenu.get()?.match.kind).toBe('dom')
  })
})

describe('applyClipboardProbe', () => {
  it('applies to the menu it was fired for', () => {
    const id = open(editableMatch)

    applyClipboardProbe(id, true)

    expect($contextMenu.get()?.clipboardHasText).toBe(true)
  })

  it('DROPS a stale probe — a slow read cannot flag a newer menu', () => {
    const stale = open(editableMatch)

    open(editableMatch)
    applyClipboardProbe(stale, true)

    expect($contextMenu.get()?.clipboardHasText).toBe(false)
  })

  it('drops a probe that lands after the menu closed', () => {
    const id = open(editableMatch)

    __resetContextMenu()
    applyClipboardProbe(id, true)

    expect($contextMenu.get()).toBeNull()
  })
})

describe('applyNativeFacts', () => {
  const spelling = { misspelledWord: 'helo', suggestions: ['hello', 'help'] }

  it('applies to the gesture it names', () => {
    const id = open(editableMatch)

    applyNativeFacts({ gestureId: id, imageBytes: false, spelling })

    expect($contextMenu.get()?.native?.spelling).toEqual(spelling)
  })

  it('drops a stale answer', () => {
    const stale = open(editableMatch)

    open(editableMatch)
    applyNativeFacts({ gestureId: stale, imageBytes: true, spelling })

    expect($contextMenu.get()?.native).toBeNull()
  })

  it('drops SPELLING for a menu with no editable, but keeps the rest', () => {
    const id = open(linkMatch)

    applyNativeFacts({ gestureId: id, imageBytes: true, spelling })

    expect($contextMenu.get()?.native?.spelling).toBeNull()
    expect($contextMenu.get()?.native?.imageBytes).toBe(true)
  })
})
