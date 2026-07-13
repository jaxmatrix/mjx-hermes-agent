import { ApprovalBar } from '@/app/chat/approval-bar'
import { Composer } from '@/app/chat/composer'
import { ChatRuntimeProvider } from '@/app/chat/runtime'
import { SidebarTrigger } from '@/app/shell/sidebar'
import { Thread } from '@/components/assistant-ui/thread/thread'
import { useStore } from '@/store/atom'
import { $approval, $busy, $statusLine, resetChat } from '@/store/chat'
import { $connection, disconnect } from '@/store/connection'

export function ChatScreen() {
  const busy = useStore($busy)
  const statusLine = useStore($statusLine)
  const approval = useStore($approval)
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
          <button className="btn btn-text" onClick={resetChat}>
            New
          </button>
          <button className="btn btn-text" onClick={disconnect}>
            Disconnect
          </button>
        </div>
      </header>

      {/* assistant-ui runtime hosts the streaming thread (markdown/reasoning/tools). */}
      <ChatRuntimeProvider>
        <Thread />
      </ChatRuntimeProvider>

      <footer className="chat-footer">
        {busy && statusLine && <div className="status-line">{statusLine}</div>}
        {approval && <ApprovalBar request={approval} />}
        <Composer />
      </footer>
    </div>
  )
}
