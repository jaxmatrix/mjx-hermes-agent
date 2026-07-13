import { AssistantRuntimeProvider, type ThreadMessageLike, useExternalStoreRuntime } from '@assistant-ui/react'
import type { ReactNode } from 'react'

import { useStore } from '@/store/atom'
import { $busy, $messages, type ChatMessage } from '@/store/chat'

// Bridges the chat store to assistant-ui via the stock external-store runtime.
// Our ChatMessage.parts ARE assistant-ui content parts, so conversion is a
// one-liner. (The desktop's ExportedMessageRepository / incremental runtime is
// for branching + perf — deferred; stock runtime is enough for v1.)
function convertMessage(message: ChatMessage): ThreadMessageLike {
  return {
    role: message.role,
    content: message.parts as ThreadMessageLike['content'],
    status:
      message.role === 'assistant'
        ? message.error
          ? { type: 'incomplete', reason: 'error', error: message.error }
          : message.pending
            ? { type: 'running' }
            : { type: 'complete', reason: 'stop' }
        : undefined
  }
}

export function ChatRuntimeProvider({ children }: { children: ReactNode }) {
  const messages = useStore($messages)
  const isRunning = useStore($busy)

  const runtime = useExternalStoreRuntime<ChatMessage>({
    messages,
    isRunning,
    convertMessage,
    // Our own Composer submits via sendPrompt; assistant-ui's composer is unused,
    // so onNew is a no-op. FIXME(G8): wire if we adopt the assistant-ui composer.
    onNew: async () => {}
  })

  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>
}
