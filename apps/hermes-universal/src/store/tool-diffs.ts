import { atom } from '@/store/atom'

// Ported from apps/desktop/src/store/tool-diffs.ts.
// Live side-channel diffs keyed by toolCallId. The tool renderer prefers a diff
// recorded here over one parsed out of the tool result.
//
// FIXME(chat-port): universal has no gateway side-channel feeding
// recordToolDiff yet (desktop's chat-messages reducer records diffs from a
// review-diff event stream — blocked, no universal event). The map therefore
// stays empty in practice and the renderer falls back to the diff embedded in
// the tool result, which is the common case. Wire recordToolDiff from the
// gateway-event handler once universal surfaces a review-diff event.
const $toolDiffs = atom<Record<string, string>>({})

export function recordToolDiff(toolCallId: string, diff: string) {
  if (!toolCallId || !diff) {
    return
  }

  const current = $toolDiffs.get()

  if (current[toolCallId] === diff) {
    return
  }

  $toolDiffs.set({ ...current, [toolCallId]: diff })
}

export function getToolDiff(toolCallId: string): string {
  return toolCallId ? $toolDiffs.get()[toolCallId] || '' : ''
}

export const $toolInlineDiffs = $toolDiffs
