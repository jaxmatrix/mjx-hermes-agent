// Trigger detection for the contentEditable composer. Ported from the
// desktop composer's text-utils.ts (the clipboard-image extraction half needs
// @/lib/embedded-images, which universal doesn't carry — image paste is deferred;
// FIXME(chat-port)).

export interface TriggerState {
  kind: '@' | '/'
  query: string
  tokenLength: number
}

// `@` triggers stop at the first whitespace — `@file:path` and `@diff` are
// single tokens. `/` triggers keep going so the popover stays live while the
// user types args. Restricting the slash command name to `[a-zA-Z][\w-]*` avoids
// matching file paths like `src/foo/bar`. Slash commands only execute at the
// beginning of a message, so `/` is anchored strictly at position 0.
const AT_TRIGGER_RE = /(?:^|[\s])(@)([^\s@/]*)$/
const SLASH_TRIGGER_RE = /^(\/)((?:[a-zA-Z][\w-]*(?:\s+\S*)*)?)$/

/** Caret-anchored visible text before the cursor, or null if the selection isn't
 *  a collapsed caret inside `editor`. */
export function textBeforeCaret(editor: HTMLDivElement): string | null {
  const sel = window.getSelection()
  const range = sel?.rangeCount ? sel.getRangeAt(0) : null

  if (!range?.collapsed || !editor.contains(range.commonAncestorContainer)) {
    return null
  }

  const before = range.cloneRange()
  before.selectNodeContents(editor)
  before.setEnd(range.startContainer, range.startOffset)

  return before.toString()
}

export function detectTrigger(textBefore: string): TriggerState | null {
  const slash = SLASH_TRIGGER_RE.exec(textBefore)

  if (slash) {
    return { kind: '/', query: slash[2], tokenLength: 1 + slash[2].length }
  }

  const at = AT_TRIGGER_RE.exec(textBefore)

  if (at) {
    return { kind: '@', query: at[2], tokenLength: 1 + at[2].length }
  }

  return null
}
