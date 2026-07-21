import { atom } from '@/store/atom'

// Ported from apps/desktop/src/store/tool-diffs.ts.
// Live side-channel diffs keyed by toolCallId. The tool renderer prefers a diff
// recorded here over one parsed out of the tool result.
//
// Fed by the `tool.complete` handler in store/chat.ts: the gateway renders the
// edit diff itself and ships it as `inline_diff` on that event
// (tui_gateway/server.py `_on_tool_complete`), keyed by the same tool id the
// part adopts in lib/chat-tool-parts.
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
