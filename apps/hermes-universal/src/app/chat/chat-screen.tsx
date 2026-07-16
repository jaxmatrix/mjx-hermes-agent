import { useCallback } from 'react'

import { ApprovalBar } from '@/app/chat/approval-bar'
import { ClarifyBar } from '@/app/chat/clarify-bar'
import { ChatBar } from '@/app/chat/composer'
import { ChatRuntimeProvider } from '@/app/chat/runtime'
import { ScrollToBottomButton } from '@/app/chat/scroll-to-bottom-button'
import { SecretBar } from '@/app/chat/secret-bar'
import { SudoBar } from '@/app/chat/sudo-bar'
import { SidebarTrigger } from '@/app/shell/sidebar'
import { Thread } from '@/components/assistant-ui/thread/thread'
import { IS_DESKTOP } from '@/lib/platform'
import { useStore } from '@/store/atom'
import { $approval, $busy, $clarify, $secret, $statusLine, $sudo, sendPrompt } from '@/store/chat'
import { enqueue, pushHistory } from '@/store/composer'
import { triggerHaptic } from '@/store/haptics'
import { $activeSessionTitle } from '@/store/session'
import { useSkinCommand } from '@/themes'

export function ChatScreen() {
  const busy = useStore($busy)
  const statusLine = useStore($statusLine)
  const approval = useStore($approval)
  const clarify = useStore($clarify)
  const sudo = useStore($sudo)
  const secret = useStore($secret)
  const title = useStore($activeSessionTitle)
  const runSkin = useSkinCommand()

  // Route the fully-composed prompt to universal's OWN gateway path (the stock
  // external-store runtime doesn't send — runtime.tsx's onNew is a no-op). The
  // client-side `/skin` command is intercepted before the gateway; a busy turn
  // queues instead of sending. Returning a string surfaces a transient composer
  // notice (the /skin result).
  const onSubmit = useCallback(
    (text: string): string | void => {
      const skin = text.match(/^\/skin(?:\s+(.*))?$/i)
      if (skin) {
        void triggerHaptic('success')
        return runSkin(skin[1] ?? '')
      }
      pushHistory(text)
      if ($busy.get()) enqueue(text)
      else void sendPrompt(text)
    },
    [runSkin]
  )

  const barsPresent = (busy && statusLine) || approval || clarify || sudo || secret

  return (
    <div className="chat">
      {/* Desktop shows the chat title in the window titlebar (see shell/titlebar);
          the phone/web build has no titlebar, so a slim header carries the sidebar
          trigger + centered title. Desktop parity retired the old host + New/
          Disconnect strip (New lives in the sidebar, sign-out in Settings). */}
      {!IS_DESKTOP && (
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-(--ui-stroke-tertiary) px-2">
          <SidebarTrigger />
          <span className="min-w-0 flex-1 truncate text-center text-sm font-medium text-(--ui-text-secondary)">
            {title || 'Hermes'}
          </span>
          <span aria-hidden className="w-9 shrink-0" />
        </header>
      )}

      {/* The runtime hosts the streaming thread AND the composer, so the
          composer's ComposerPrimitive.Input / trigger popover have runtime
          context. The thread column (`.chat`, position: relative) is the
          positioning context; the composer overlays it, docked at the bottom,
          and the approval/clarify/sudo/secret bars + status line overlay just
          above the composer surface. */}
      <ChatRuntimeProvider>
        <Thread />
        <ScrollToBottomButton />
        {barsPresent && (
          <div className="composer-bars">
            {busy && statusLine && <div className="status-line">{statusLine}</div>}
            {approval && <ApprovalBar request={approval} />}
            {clarify && <ClarifyBar request={clarify} />}
            {sudo && <SudoBar request={sudo} />}
            {secret && <SecretBar request={secret} />}
          </div>
        )}
        <ChatBar onSubmit={onSubmit} />
      </ChatRuntimeProvider>
    </div>
  )
}
