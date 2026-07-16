import { ThreadPrimitive } from '@assistant-ui/react'

import { AssistantMessage } from './assistant-message'
import { ThreadMessageList } from './list'
import { SystemMessage } from './system-message'
import { UserMessage } from './user-message'

// Universal's empty state (kept from the original thin thread) — the brand mark
// plus a hint. Desktop's richer <Intro> pulls its own large dependency tree, so
// it's intentionally not ported here.
const EmptyPlaceholder = (
  <div className="flex min-h-0 w-full flex-col items-center justify-center">
    <div className="empty">
      <div className="brand">Hermes</div>
      <p>Send a message to start.</p>
    </div>
  </div>
)

// The chat thread. ThreadMessageList (ported from desktop) owns stick-to-bottom
// scrolling: it follows while parked at the bottom, escapes on scroll-up, pins
// the latest human message to the top of its turn while the reply streams, and
// groups each user prompt with the assistant turn(s) that follow it.
//
// GATED (blocked on universal's stock external-store runtime): desktop's
// ThreadTimeline minimap, inline UserEditComposer, and restore-checkpoint
// ConfirmDialog flow all need the branching/checkpoint runtime — omitted here.
// The floating scroll-to-bottom button renders in chat-screen.tsx.
export function Thread() {
  return (
    <ThreadPrimitive.Root className="relative flex min-h-0 flex-1 flex-col bg-transparent contain-[layout_paint]">
      <ThreadMessageList
        clampToComposer={false}
        components={{ AssistantMessage, SystemMessage, UserMessage }}
        emptyPlaceholder={EmptyPlaceholder}
      />
    </ThreadPrimitive.Root>
  )
}
