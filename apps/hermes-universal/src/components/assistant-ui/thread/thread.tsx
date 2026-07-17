import { ThreadPrimitive } from '@assistant-ui/react'

import { Intro } from '@/components/chat/intro'

import { AssistantMessage } from './assistant-message'
import { ThreadMessageList } from './list'
import { ResponseLoadingIndicator } from './status'
import { SystemMessage } from './system-message'
import { UserMessage } from './user-message'

// New-conversation empty state — desktop's <Intro>: the auto-fit "HERMES AGENT"
// wordmark + a rotating neutral tagline. Centered and pushed above the docked
// composer by its measured height, matching desktop's placement.
const EmptyPlaceholder = (
  <div className="flex min-h-0 w-full flex-col items-center justify-center pt-[var(--composer-measured-height)]">
    <Intro />
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
        clampToComposer
        components={{ AssistantMessage, SystemMessage, UserMessage }}
        emptyPlaceholder={EmptyPlaceholder}
        loadingIndicator={<ResponseLoadingIndicator />}
      />
    </ThreadPrimitive.Root>
  )
}
