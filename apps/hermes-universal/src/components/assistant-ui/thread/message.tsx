import { MessagePrimitive } from '@assistant-ui/react'

import { MESSAGE_PARTS } from './message-parts'

export function UserMessage() {
  return (
    <MessagePrimitive.Root className="msg msg-user">
      <div className="msg-bubble">
        <MessagePrimitive.Parts />
      </div>
    </MessagePrimitive.Root>
  )
}

export function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="msg msg-assistant">
      <div className="msg-bubble">
        <MessagePrimitive.Parts components={MESSAGE_PARTS} />
      </div>
    </MessagePrimitive.Root>
  )
}
