import { useState } from 'react'

import { ApprovalBar } from '@/app/chat/approval-bar'
import { ClarifyBar } from '@/app/chat/clarify-bar'
import { Composer } from '@/app/chat/composer'
import { ChatRuntimeProvider } from '@/app/chat/runtime'
import { SecretBar } from '@/app/chat/secret-bar'
import { SessionSheet } from '@/app/chat/session-sheet'
import { SudoBar } from '@/app/chat/sudo-bar'
import { SidebarTrigger } from '@/app/shell/sidebar'
import { Thread } from '@/components/assistant-ui/thread/thread'
import { useStore } from '@/store/atom'
import { $approval, $busy, $clarify, $secret, $statusLine, $sudo } from '@/store/chat'
import { $connection, disconnect } from '@/store/connection'
import { newSession } from '@/store/session'

export function ChatScreen() {
  const [historyOpen, setHistoryOpen] = useState(false)
  const busy = useStore($busy)
  const statusLine = useStore($statusLine)
  const approval = useStore($approval)
  const clarify = useStore($clarify)
  const sudo = useStore($sudo)
  const secret = useStore($secret)
  const connection = useStore($connection)

  const host = connection ? new URL(connection.baseUrl).host : ''

  return (
    <div className="chat">
      <header className="chat-header">
        <div className="chat-host">
          <SidebarTrigger className="md:hidden" />
          <span className="dot dot-ok" />
          {host}
        </div>
        <div className="chat-actions">
          <button className="btn btn-text" onClick={() => setHistoryOpen(true)}>
            History
          </button>
          <button className="btn btn-text" onClick={newSession}>
            New
          </button>
          <button className="btn btn-text" onClick={disconnect}>
            Disconnect
          </button>
        </div>
      </header>

      <SessionSheet onOpenChange={setHistoryOpen} open={historyOpen} />

      {/* assistant-ui runtime hosts the streaming thread (markdown/reasoning/tools). */}
      <ChatRuntimeProvider>
        <Thread />
      </ChatRuntimeProvider>

      <footer className="chat-footer">
        {busy && statusLine && <div className="status-line">{statusLine}</div>}
        {approval && <ApprovalBar request={approval} />}
        {clarify && <ClarifyBar request={clarify} />}
        {sudo && <SudoBar request={sudo} />}
        {secret && <SecretBar request={secret} />}
        <Composer />
      </footer>
    </div>
  )
}
