// Universal adapter for the ported composer. Desktop's chat-messages.ts models
// messages as assistant-ui `content` parts; universal's core reducer
// (@/store/chat) uses its own `{ role, parts }` ChatMessage. To keep ONE message
// type across the app, this re-exports universal's ChatMessage and reimplements
// the only helper the composer needs (`chatMessageText`) against universal's
// `parts` shape. The logic is identical to desktop's: concatenate text parts.

import type { ChatMessage } from '@/store/chat'

export type { ChatMessage }

/** The plain-text of a message: all text parts concatenated (reasoning/tool parts dropped). */
export function chatMessageText(message: ChatMessage): string {
  return message.parts
    .filter((part): part is Extract<ChatMessage['parts'][number], { type: 'text' }> => part.type === 'text')
    .map(part => part.text)
    .join('')
}
