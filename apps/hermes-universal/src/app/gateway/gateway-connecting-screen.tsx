import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'

import { GatewayConfigurator } from '@/app/gateway/gateway-configurator'
import { sshStepLabel } from '@/app/gateway/ssh-copy'
import { landingSessionId, resolveSessionLanding } from '@/app/session-landing'
import { CachedTranscriptPreview } from '@/components/chat/cached-transcript-preview'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import type { ChatMessage } from '@/lib/chat-messages'
import { Loader2 } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { useStore } from '@/store/atom'
import { $connectionError } from '@/store/connection'
import { cancelRestore, loadGatewayTarget } from '@/store/gateway-restore'
import { $restorePaintEnabled } from '@/store/restore-paint'
import { lastOpenedSessionId } from '@/store/session'
import { $sshStep } from '@/store/ssh-backend'
import { $transcriptPaint, BOOT_PAINT_KEY, clearTranscriptPaint, paintCachedTail } from '@/store/transcript-paint'
import { ownsPersistedAppState } from '@/store/windows'

// Full-screen "reconnecting to the last gateway" screen (D8). Shown by
// MobileController while the boot-time auto-connect dials, and while an in-session
// reconnect (dropped socket / settings "Save & reconnect") is re-homing — instead
// of bouncing to the connect picker. Mirrors desktop's gateway-connecting overlay.
// The escape hatch ("Use a different gateway") abandons the restore and drops to
// the connect picker.

/** Human label for the gateway being (re)connected to, for the status line. */
function targetLabel(): string {
  const target = loadGatewayTarget()

  if (!target) {
    return 'Hermes'
  }

  if (target.mode === 'local') {
    return 'the local backend'
  }

  if (target.mode === 'ssh') {
    // The saved host, not the baseUrl: an ssh connection's baseUrl is a loopback
    // port that means nothing to the user.
    return target.ssh?.host || 'the SSH host'
  }

  if (target.mode === 'cloud') {
    if (target.cloudAgentName) {
      return target.cloudAgentName
    }

    return hostOf(target.cloudBaseUrl) ?? 'Hermes Cloud'
  }

  return hostOf(target.url) ?? 'the remote gateway'
}

function hostOf(url?: string): null | string {
  if (!url) {
    return null
  }

  try {
    return new URL(/^https?:\/\//i.test(url) ? url : `http://${url}`).host
  } catch {
    return url.replace(/^https?:\/\//i, '').replace(/\/.*$/, '') || null
  }
}

/**
 * The cached tail of the conversation this launch will land on, read ONCE, in
 * the first render (MJXHRM-480).
 *
 * Synchronous by construction — one `getItem` and one `JSON.parse` — because an
 * effect would paint one blank frame first, and the blank frame is the thing
 * this feature exists to remove. `resolveSessionLanding` is the ONE answer to
 * "which conversation does a standing start land on" (MJXHRM-438); asking it
 * here rather than re-deriving is what keeps this surface from disagreeing with
 * the shell that is about to open the same chat.
 *
 * `ownsPersistedAppState()` gates it: "which conversation you were last in" is
 * single-writer app state, so a detached tile window or an Android
 * `ScreenActivity` must not paint a boot transcript of its own. (The COLD-OPEN
 * paint is not gated that way — a session's tail is not that kind of value.)
 */
function useBootPaint(): ChatMessage[] | null {
  const { pathname } = useLocation()
  const enabled = useStore($restorePaintEnabled)

  // The initializer runs once. `paintCachedTail` refuses a second paint for the
  // same key, so a StrictMode double-invoke is a no-op rather than a double read.
  const [messages] = useState<ChatMessage[] | null>(() => {
    if (!enabled || !ownsPersistedAppState()) {
      return null
    }

    const landing = landingSessionId(resolveSessionLanding(pathname, lastOpenedSessionId()))

    return paintCachedTail(BOOT_PAINT_KEY, landing) ? ($transcriptPaint.get()[BOOT_PAINT_KEY]?.messages ?? null) : null
  })

  // The root gate swaps this whole screen out when the connection is ready; the
  // paint must not outlive it, or `awaitSessionPainted` would answer for a
  // surface nobody is looking at.
  useEffect(() => () => clearTranscriptPaint(BOOT_PAINT_KEY), [])

  return enabled ? messages : null
}

export function GatewayConnectingScreen() {
  const { t } = useI18n()
  const g = t.settings.gateway
  const error = useStore($connectionError)
  const bootPaint = useBootPaint()
  // An SSH connect spawns a process on the remote and waits for it to bind, which
  // can take 45-90s. Without the step the screen is a motionless spinner for long
  // enough to read as a hang.
  const sshStep = useStore($sshStep)

  // Recovery in place (desktop's boot-failure card): rather than only offering the
  // hard "give up → connect picker" exit, re-home from right here with the embedded
  // configurator. Revealed automatically once the dial has actually failed; the
  // button covers a reconnect that is stuck but not yet errored.
  const [configuratorOpen, setConfiguratorOpen] = useState(false)

  useEffect(() => {
    if (error) {
      setConfiguratorOpen(true)
    }
  }, [error])

  return (
    <main className="connect relative">
      {bootPaint ? <CachedTranscriptPreview messages={bootPaint} /> : null}
      <div className={cn('connect-card relative items-center text-center', configuratorOpen && 'max-w-lg')}>
        <div className="brand">Hermes</div>
        <h1 className="connect-title">{g.connectingTitle}</h1>

        <div className="mt-2 flex items-center gap-2 text-[length:var(--conversation-caption-font-size)] text-(--ui-text-secondary)">
          <Loader2 className="size-4 animate-spin" />
          {g.reconnectingTo(targetLabel())}
        </div>

        {sshStep ? (
          <div className="mt-1 text-[0.8125rem] text-(--ui-text-secondary)">{sshStepLabel(sshStep, g)}</div>
        ) : null}

        {error ? <div className="mt-1 text-[0.8125rem] text-destructive">{error}</div> : null}

        {configuratorOpen ? (
          <>
            {/* The card is centred; the configurator's rows are not. A successful
                connect flips $connectionPhase to ready and the root gate swaps this
                whole screen out, so it needs no onConnected. */}
            <div className="mt-4 w-full text-start">
              <GatewayConfigurator variant="embedded" />
            </div>
            <Button className="mt-2" onClick={() => cancelRestore()} size="sm" type="button" variant="text">
              {g.startOver}
            </Button>
          </>
        ) : (
          <Button className="mt-4" onClick={() => setConfiguratorOpen(true)} size="sm" type="button" variant="text">
            {g.useDifferentGateway}
          </Button>
        )}
      </div>
    </main>
  )
}
