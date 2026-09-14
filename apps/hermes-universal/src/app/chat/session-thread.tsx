import { useMemo } from 'react'

import { ApprovalBar } from '@/app/chat/approval-bar'
import { ChatRuntimeProvider } from '@/app/chat/runtime'
import { SecretBar } from '@/app/chat/secret-bar'
import { SessionViewProvider } from '@/app/chat/session-view'
import { buildSessionView } from '@/app/chat/session-view-build'
import { SudoBar } from '@/app/chat/sudo-bar'
import { Thread } from '@/components/assistant-ui/thread/thread'
import { useStore } from '@/store/atom'
import { sessionApprovalRequest, sessionSecretRequest, sessionSudoRequest } from '@/store/prompts'

/**
 * ONE session's transcript, mounted anywhere — the app's own thread, for a
 * session that is not the focused one.
 *
 * `<Thread>` takes no props: it reads `useSessionView()`, and the only producer
 * of a non-primary view was `session-tile.tsx`'s private `buildTileView`. That
 * made every surface wanting a foreign session's transcript re-implement one —
 * which is what desktop's Bot Mode did, hand-mirroring approvals and clarify
 * into its room and then drifting from the real UI on every transcript feature
 * that shipped afterwards (`1179f148e4`, `c757f99e63`).
 *
 * So the view builder moved to `session-view-build.ts` and this is the mount:
 * transcript + the three blocking-prompt bars, no composer and no header. A
 * clarify question renders INSIDE the transcript (it is a tool part), so it
 * arrives here for free; the bars are the ones that live beside the composer in
 * `chat-screen.tsx`, which this surface does not have.
 *
 * Answering goes through these components, not through a caller-forged
 * `approval.respond` — one answer path is what keeps MJXHRM-458's `requestId`
 * correlation from drifting.
 */
export function SessionThread({ storedSessionId }: { storedSessionId: string }) {
  const view = useMemo(() => buildSessionView(storedSessionId), [storedSessionId])
  const sessionKey = useStore(view.$runtimeId) ?? ''
  const approval = useStore(sessionApprovalRequest(sessionKey))
  const sudo = useStore(sessionSudoRequest(sessionKey))
  const secret = useStore(sessionSecretRequest(sessionKey))

  return (
    <SessionViewProvider value={view}>
      <ChatRuntimeProvider>
        <Thread />
        {(approval || sudo || secret) && (
          <div className="composer-bars">
            {approval && <ApprovalBar request={approval} sessionKey={sessionKey} />}
            {sudo && <SudoBar request={sudo} sessionKey={sessionKey} />}
            {secret && <SecretBar request={secret} sessionKey={sessionKey} />}
          </div>
        )}
      </ChatRuntimeProvider>
    </SessionViewProvider>
  )
}
