import type { ContextGesture, ContextTargetMatch, NativeContextFacts } from '@/app/context-menu/registry'
import type { ContextMenuDomTarget } from '@/app/context-menu/target'
import { atom } from '@/store/atom'

// The open menu. ONE atom, so two menus can never be open at once and a second
// gesture simply replaces the first — the state machine that guarantee buys is
// worth more than any queue would be.
//
// Both LATE FACTS (the clipboard probe, and the v2 native bridge) are applied
// through identity-guarded setters: an answer that resolves after the user
// opened a different menu must not flag that menu.

export type { NativeContextFacts }

export interface OpenContextMenu {
  /** Monotonic per webview. Identity for every late fact. */
  id: number
  x: number
  y: number
  source: ContextGesture['source']
  match: ContextTargetMatch
  gesture: ContextGesture
  clipboardHasText: boolean
  native: NativeContextFacts | null
  /** Kinds whose classifier threw while this gesture was being classified. */
  failed: string[]
}

export interface OpenContextMenuInput {
  x: number
  y: number
  source: ContextGesture['source']
  match: ContextTargetMatch
  gesture: ContextGesture
  failed?: string[]
}

let nextId = 0

export const $contextMenu = atom<null | OpenContextMenu>(null)

export function openContextMenu(input: OpenContextMenuInput): number {
  nextId += 1

  $contextMenu.set({
    clipboardHasText: false,
    failed: input.failed ?? [],
    gesture: input.gesture,
    id: nextId,
    match: input.match,
    native: null,
    source: input.source,
    x: input.x,
    y: input.y
  })

  return nextId
}

export function closeContextMenu(): void {
  if ($contextMenu.get()) {
    $contextMenu.set(null)
  }
}

/** Late fact 1. A probe that resolves after a newer menu opened is dropped. */
export function applyClipboardProbe(id: number, hasText: boolean): void {
  const open = $contextMenu.get()

  if (!open || open.id !== id || open.clipboardHasText === hasText) {
    return
  }

  $contextMenu.set({ ...open, clipboardHasText: hasText })
}

/**
 * Late fact 2 (v2 — nothing emits it in v1).
 *
 * Guarded by the same id, and `spelling` is additionally dropped unless the open
 * menu is a `dom` target with an editable: a suggestion list over a link menu
 * would be a lie about what the engine was asked.
 */
export function applyNativeFacts(facts: NativeContextFacts): void {
  const open = $contextMenu.get()

  if (!open || open.id !== facts.gestureId) {
    return
  }

  const editable = open.match.kind === 'dom' && (open.match.data as ContextMenuDomTarget).editable !== null

  $contextMenu.set({ ...open, native: editable ? facts : { ...facts, spelling: null } })
}

/** Test seam. */
export function __resetContextMenu(): void {
  nextId = 0
  $contextMenu.set(null)
}
