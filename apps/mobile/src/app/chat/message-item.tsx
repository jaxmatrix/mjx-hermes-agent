import { useState } from 'react'

import type { ChatMessage } from '@/store/chat'

export function MessageItem({ message }: { message: ChatMessage }) {
  const [showReasoning, setShowReasoning] = useState(false)
  const isUser = message.role === 'user'

  return (
    <div className={`msg ${isUser ? 'msg-user' : 'msg-assistant'}`}>
      {message.reasoning && (
        <div className="reasoning">
          <button className="reasoning-toggle" onClick={() => setShowReasoning(v => !v)}>
            {showReasoning ? 'Hide reasoning' : 'Show reasoning'}
          </button>
          {showReasoning && <div className="reasoning-body">{message.reasoning}</div>}
        </div>
      )}

      {message.tools.length > 0 && (
        <div className="tools">
          {message.tools.map(tool => (
            <span key={tool.key} className={`tool-chip ${tool.done ? 'tool-done' : 'tool-running'}`}>
              {tool.name}
              {!tool.done && <span className="tool-dot" />}
            </span>
          ))}
        </div>
      )}

      {message.text && (
        <div className="msg-bubble">
          {message.text}
          {message.streaming && <span className="caret" />}
        </div>
      )}

      {!message.text && message.streaming && message.tools.length === 0 && (
        <div className="msg-bubble msg-thinking">
          <span className="caret" />
        </div>
      )}
    </div>
  )
}
