import { ChatScreen } from '@/app/chat/chat-screen'
import { ConnectScreen } from '@/app/connect-screen'
import { useStore } from '@/store/atom'
import { $connectionPhase } from '@/store/connection'

export function App() {
  const phase = useStore($connectionPhase)
  return phase === 'ready' ? <ChatScreen /> : <ConnectScreen />
}
