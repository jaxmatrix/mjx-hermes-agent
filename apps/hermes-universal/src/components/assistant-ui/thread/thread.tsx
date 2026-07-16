import { ThreadPrimitive } from '@assistant-ui/react'

import { AssistantMessage } from './assistant-message'
import { UserMessage } from './user-message'

// The chat thread. ThreadPrimitive.Viewport owns stick-to-bottom scrolling.
export function Thread() {
  return (
    <ThreadPrimitive.Root className="flex min-h-0 flex-1 flex-col">
      <ThreadPrimitive.Viewport className="flex-1 overflow-y-auto px-3 py-4" autoScroll>
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
          <ThreadPrimitive.Empty>
            <div className="empty">
              <div className="brand">Hermes</div>
              <p>Send a message to start.</p>
            </div>
          </ThreadPrimitive.Empty>
          <ThreadPrimitive.Messages components={{ AssistantMessage, UserMessage }} />
        </div>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  )
}
