/**
 * Paint a live `message.reaction` gateway event onto a session slice.
 * Protected host glue — desktop routes reactions differently; do not fold
 * into AUTO `reactions.ts`.
 */
import { recordAgentReaction } from '@/store/reactions-local'
import { updateSession } from '@/store/session-state-types'
import type { MessageReaction } from '@/types/hermes'

export function applyReactionEvent(
  sessionKey: string,
  rowId: number,
  role: 'assistant' | 'user',
  reactions: MessageReaction[]
): void {
  recordAgentReaction(rowId, reactions)

  updateSession(sessionKey, state => {
    const byRowId = state.messages.find(message => message.rowId === rowId)

    if (byRowId) {
      return {
        ...state,
        messages: state.messages.map(message =>
          message.rowId === rowId ? { ...message, reactions } : message
        )
      }
    }

    const lastIndex = state.messages.findLastIndex(
      message => message.role === role && message.rowId === undefined
    )

    if (lastIndex < 0) {
      return state
    }

    return {
      ...state,
      messages: state.messages.map((message, index) =>
        index === lastIndex ? { ...message, reactions, rowId } : message
      )
    }
  })
}
