import { AssistantRuntimeProvider, type ThreadMessageLike, useExternalStoreRuntime } from '@assistant-ui/react'
import type { ReactNode } from 'react'

import { useSessionView } from '@/app/chat/session-view'
import { useStore } from '@/store/atom'
import { type ChatMessage } from '@/store/chat'

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
  // Read from the SessionView so a tile renders ITS session's transcript. The
  // default context is PRIMARY_SESSION_VIEW (whose $messages/$busy ARE the global
  // atoms), so the primary chat is unchanged.
  const view = useSessionView()
  const messages = useStore(view.$messages)
  const isRunning = useStore(view.$busy)

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
