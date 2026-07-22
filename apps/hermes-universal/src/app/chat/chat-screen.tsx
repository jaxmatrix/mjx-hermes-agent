import { useCallback, useEffect } from 'react'

import { ApprovalBar } from '@/app/chat/approval-bar'
import {
  pickAttachment,
  pickFolderAttachment,
  type StagedAttachment,
  stagedToComposerAttachment
} from '@/app/chat/attachments'
import { ChatDropOverlay } from '@/app/chat/chat-drop-overlay'
import { ChatHeader } from '@/app/chat/chat-header'
import { ClarifyBar } from '@/app/chat/clarify-bar'
import { ChatBar } from '@/app/chat/composer'
import { ChatRuntimeProvider } from '@/app/chat/runtime'
import { ScrollToBottomButton } from '@/app/chat/scroll-to-bottom-button'
import { SecretBar } from '@/app/chat/secret-bar'
import { SudoBar } from '@/app/chat/sudo-bar'
import { useComposerScope } from '@/app/chat/composer/scope'
import { useSessionView } from '@/app/chat/session-view'
import { useFileDrop } from '@/app/chat/use-file-drop'
import { ModelMenuPanel } from '@/app/shell/model-menu-panel'
import { Thread } from '@/components/assistant-ui/thread/thread'
import { transcribeAudio } from '@/hermes'
import { triggerHaptic } from '@/lib/haptics'
import { useStore } from '@/store/atom'
import { $approval, $clarify, $secret, $statusLine, $sudo, sendPrompt } from '@/store/chat'
import { type ComposerAttachment } from '@/store/composer'
import { $gatewayState, getGatewayClient, requestGateway } from '@/store/gateway'
import { refreshCurrentModel, selectModel } from '@/store/model'
import { sessionTileDelegate } from '@/store/session-states'
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
  // The SessionView is the data surface; the ComposerScope routes actions. Both
  // default to PRIMARY_SESSION_VIEW / MAIN_COMPOSER_SCOPE (whose atoms ARE the
  // global chat atoms), so the primary chat is unchanged; a session TILE mounts
  // this same ChatScreen under its own view + scope.
  const view = useSessionView()
  const scope = useComposerScope()
  const isPrimary = view.kind === 'primary'

  const busy = useStore(view.$busy)
  const sessionId = useStore(view.$runtimeId)
  const cwd = useStore(view.$cwd)
  const currentModel = useStore(view.$model)
  const currentProvider = useStore(view.$provider)
  const statusLine = useStore($statusLine)
  // Blocking-prompt bars are the PRIMARY chat's inline UI; a tile surfaces its
  // prompts via PromptOverlays (per-session), so these read the global atoms and
  // only render for the primary.
  const approval = useStore($approval)
  const clarify = useStore($clarify)
  const sudo = useStore($sudo)
  const secret = useStore($secret)
  const gatewayState = useStore($gatewayState)
  const runSkin = useSkinCommand()
  const { dragActive } = useFileDrop()

  // Seed the composer's model/provider from the profile default once the gateway
  // is up (only fills an empty selection). Primary only — a tile shows its own
  // session's model and must not overwrite the global default.
  useEffect(() => {
    if (isPrimary && gatewayState === 'open') {
      void refreshCurrentModel()
    }
  }, [isPrimary, gatewayState])

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

      // Route by scope: the main composer submits the primary chat; a tile's
      // composer submits to its own session through the tile delegate.
      if (scope.target === 'main') {
        await sendPrompt(full)
      } else {
        const rt = view.$runtimeId.get()

        if (rt) {
          await sessionTileDelegate()?.submitToSession(rt, full)
        }
      }

      return true
    },
    [runSkin, scope, view]
  )

  // Interrupt the running turn (Esc / Stop). Best-effort — a backend without
  // session.interrupt simply rejects and the turn keeps running.
  const onCancel = useCallback(() => {
    const sid = view.$runtimeId.get()

    if (!sid) {
      return
    }

    if (scope.target === 'main') {
      void requestGateway('session.interrupt', { session_id: sid }).catch(() => {})
    } else {
      void sessionTileDelegate()?.interruptSession(sid)
    }
  }, [scope, view])

  const addStagedToScope = (staged: StagedAttachment | null) => {
    if (staged) {
      scope.attachments.add(stagedToComposerAttachment(staged))
    }
  }

  const onPickFiles = useCallback(() => void pickAttachment().then(addStagedToScope), [scope])
  const onPickImages = useCallback(() => void pickAttachment().then(addStagedToScope), [scope])
  const onPickFolders = useCallback(() => void pickFolderAttachment().then(addStagedToScope), [scope])
  const onRemoveAttachment = useCallback((id: string) => scope.attachments.remove(id), [scope])

  const onTranscribeAudio = useCallback(async (audio: Blob): Promise<string> => {
    const dataUrl = await blobToDataUrl(audio)
    const res = await transcribeAudio(dataUrl, audio.type || undefined)

    return res.transcript ?? ''
  }, [])

  // Inline bars + status line are the PRIMARY chat's UI (they read the global
  // prompt atoms); a tile surfaces its prompts via PromptOverlays instead.
  const barsPresent = isPrimary && ((busy && statusLine) || approval || clarify || sudo || secret)

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
            {busy && statusLine && <div className="pl-0.5 text-[0.8125rem] text-muted-foreground">{statusLine}</div>}
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
              // Model switching targets the primary chat's session; a tile's
              // per-session model menu is wired in Phase 7 (tile actions).
              canSwitch: isPrimary && gatewayState === 'open',
              modelMenuContent: isPrimary ? (
                <ModelMenuPanel
                  gateway={getGatewayClient() ?? undefined}
                  onSelectModel={selectModel}
                  requestGateway={requestGateway}
                />
              ) : null
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
