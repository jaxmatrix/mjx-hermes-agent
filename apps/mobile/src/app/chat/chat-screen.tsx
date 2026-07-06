import { useEffect, useRef } from 'react'

import { ApprovalBar } from '@/app/chat/approval-bar'
import { Composer } from '@/app/chat/composer'
import { MessageItem } from '@/app/chat/message-item'
import { useStore } from '@/store/atom'
import { $approval, $busy, $messages, $statusLine, resetChat } from '@/store/chat'
import { $connection, disconnect } from '@/store/connection'

export function ChatScreen() {
  const messages = useStore($messages)
  const busy = useStore($busy)
  const statusLine = useStore($statusLine)
  const approval = useStore($approval)
  const connection = useStore($connection)

  const threadRef = useRef<HTMLDivElement>(null)

  // Keep the newest content in view as it streams.
  useEffect(() => {
    const el = threadRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, busy, statusLine, approval])

  const host = connection ? new URL(connection.baseUrl).host : ''

  return (
    <div className="chat">
      <header className="chat-header">
        <div className="chat-host">
          <span className="dot dot-ok" />
          {host}
        </div>
        <div className="chat-actions">
          <button className="btn btn-text" onClick={resetChat}>
            New
          </button>
          <button className="btn btn-text" onClick={disconnect}>
            Disconnect
          </button>
        </div>
      </header>

      <div className="thread" ref={threadRef}>
        {messages.length === 0 && (
          <div className="empty">
            <div className="brand">Hermes</div>
            <p>Send a message to start.</p>
          </div>
        )}
        {messages.map(message => (
          <MessageItem key={message.id} message={message} />
        ))}
        {busy && statusLine && <div className="status-line">{statusLine}</div>}
      </div>

      <footer className="chat-footer">
        {approval && <ApprovalBar request={approval} />}
        <Composer />
      </footer>
    </div>
  )
}
