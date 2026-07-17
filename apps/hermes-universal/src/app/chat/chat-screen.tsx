import { useCallback, useEffect } from 'react'

import { ApprovalBar } from '@/app/chat/approval-bar'
import { pickAttachment, pickFolderAttachment, type StagedAttachment, stagedToComposerAttachment } from '@/app/chat/attachments'
import { ChatDropOverlay } from '@/app/chat/chat-drop-overlay'
import { ChatHeader } from '@/app/chat/chat-header'
import { ClarifyBar } from '@/app/chat/clarify-bar'
import { ChatBar } from '@/app/chat/composer'
import { ChatRuntimeProvider } from '@/app/chat/runtime'
import { ScrollToBottomButton } from '@/app/chat/scroll-to-bottom-button'
import { useFileDrop } from '@/app/chat/use-file-drop'
import { SecretBar } from '@/app/chat/secret-bar'
import { SudoBar } from '@/app/chat/sudo-bar'
import { transcribeAudio } from '@/hermes'
import { ModelMenuPanel } from '@/app/shell/model-menu-panel'
import { Thread } from '@/components/assistant-ui/thread/thread'
import { useStore } from '@/store/atom'
import { $busy, $currentCwd, $sessionId, $statusLine, $approval, $clarify, $secret, $sudo, sendPrompt } from '@/store/chat'
import { type ComposerAttachment, mainComposerScope } from '@/store/composer'
import { $gatewayState, getGatewayClient, requestGateway } from '@/store/gateway'
import { triggerHaptic } from '@/store/haptics'
import { $currentModel, $currentProvider, refreshCurrentModel, selectModel } from '@/store/model'
import { useSkinCommand } from '@/themes'

// Read a recorded audio blob into a base64 data URL for the gateway audio.* RPC.
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

export function ChatScreen() {
  const busy = useStore($busy)
  const statusLine = useStore($statusLine)
  const approval = useStore($approval)
  const clarify = useStore($clarify)
  const sudo = useStore($sudo)
  const secret = useStore($secret)
  const sessionId = useStore($sessionId)
  const cwd = useStore($currentCwd)
  const gatewayState = useStore($gatewayState)
  const currentModel = useStore($currentModel)
  const currentProvider = useStore($currentProvider)
  const runSkin = useSkinCommand()
  const { dragActive } = useFileDrop()

  // Seed the composer's model/provider from the profile default once the gateway
  // is up (only fills an empty selection — a user's pick / session model wins).
  useEffect(() => {
    if (gatewayState === 'open') {
      void refreshCurrentModel()
    }
  }, [gatewayState])

  // Route the fully-composed prompt to universal's gateway path. The ported
  // ChatBar owns draft/queue/history internally, so the parent only sends: the
  // client-side `/skin` command is intercepted first; staged attachment refs are
  // spliced ahead of the text. Returns true once the send is issued.
  const onSubmit = useCallback(
    async (text: string, options?: { attachments?: ComposerAttachment[] }): Promise<boolean> => {
      const skin = text.match(/^\/skin(?:\s+(.*))?$/i)
      if (skin) {
        void triggerHaptic('success')
        runSkin(skin[1] ?? '')
        return true
      }

      const refs = (options?.attachments ?? []).map(a => a.refText).filter((r): r is string => Boolean(r))
      const full = [...refs, text].filter(Boolean).join(' ')

      if (!full.trim()) {
        return false
      }

      await sendPrompt(full)
      return true
    },
    [runSkin]
  )

  // Interrupt the running turn (Esc / Stop). Best-effort — a backend without
  // session.interrupt simply rejects and the turn keeps running.
  const onCancel = useCallback(() => {
    const sid = $sessionId.get()
    if (sid) {
      void requestGateway('session.interrupt', { session_id: sid }).catch(() => {})
    }
  }, [])

  const addStagedToScope = (staged: StagedAttachment | null) => {
    if (staged) {
      mainComposerScope.add(stagedToComposerAttachment(staged))
    }
  }

  const onPickFiles = useCallback(() => void pickAttachment().then(addStagedToScope), [])
  const onPickImages = useCallback(() => void pickAttachment().then(addStagedToScope), [])
  const onPickFolders = useCallback(() => void pickFolderAttachment().then(addStagedToScope), [])
  const onRemoveAttachment = useCallback((id: string) => mainComposerScope.remove(id), [])

  const onTranscribeAudio = useCallback(async (audio: Blob): Promise<string> => {
    const dataUrl = await blobToDataUrl(audio)
    const res = await transcribeAudio(dataUrl, audio.type || undefined)
    return res.transcript ?? ''
  }, [])

  const barsPresent = (busy && statusLine) || approval || clarify || sudo || secret

  return (
    <div className="chat">
      {/* The chat title lives INSIDE the chat area (desktop parity — see
          chat-header.tsx / desktop's in-pane ChatHeader), so it tracks the chat
          pane when the left sidebar opens and is absent on non-chat views. On
          mobile it also carries the sidebar-drawer trigger. */}
      <ChatHeader />

      {/* The runtime hosts the streaming thread AND the composer, so the
          composer's ComposerPrimitive.Input / trigger popover have runtime
          context. */}
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
        <ChatBar
          busy={busy}
          cwd={cwd}
          disabled={gatewayState !== 'open'}
          focusKey={sessionId}
          gateway={getGatewayClient()}
          onCancel={onCancel}
          onPickFiles={onPickFiles}
          onPickFolders={onPickFolders}
          onPickImages={onPickImages}
          onRemoveAttachment={onRemoveAttachment}
          onSubmit={onSubmit}
          onTranscribeAudio={onTranscribeAudio}
          queueSessionKey={sessionId}
          sessionId={sessionId}
          state={{
            model: {
              model: currentModel,
              provider: currentProvider,
              canSwitch: gatewayState === 'open',
              modelMenuContent: (
                <ModelMenuPanel
                  gateway={getGatewayClient() ?? undefined}
                  onSelectModel={selectModel}
                  requestGateway={requestGateway}
                />
              )
            },
            tools: { enabled: true, label: 'Add context' },
            voice: { enabled: true, active: false }
          }}
        />
      </ChatRuntimeProvider>

      {/* OS file drag-and-drop affordance — covers the whole chat area (Tauri
          delivers drops window-globally; the drop is handled by useFileDrop). */}
      <ChatDropOverlay active={dragActive} />
    </div>
  )
}
