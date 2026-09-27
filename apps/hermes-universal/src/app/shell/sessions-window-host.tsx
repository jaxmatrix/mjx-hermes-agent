import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'

import { SidebarScrollBody } from '@/app/chat/sidebar/sidebar-content'
import { resumeSessionIntoMain } from '@/app/resume-session-into-main'
import {
  SessionsWindow,
  type SessionsWindowProfile,
  type SessionsWindowTab
} from '@/app/shell/sessions-window'
import { useMobileNavItems } from '@/app/shell/use-mobile-nav-items'
import { useI18n } from '@/i18n'
import { ESCAPE_PRIORITY, isTopEscapeLayer, pushEscapeLayer } from '@/lib/escape-layers'
import { resolveProfileColor } from '@/lib/profile-color'
import { logSessionsRoute } from '@/lib/sessions-route-log'
import { $botsPaneVisible, $openBotChat } from '@/plugins/hermes-bots/bot-state'
import { useStore } from '@/store/atom'
import { openStoredSessionInBubble } from '@/store/chat-bubbles'
import {
  $activeGatewayProfile,
  $profileColors,
  $profiles,
  profileLabel,
  selectProfile
} from '@/store/profile'
import type { SessionInfo } from '@/types/hermes'

const BotsPane = lazy(async () => {
  const mod = await import('@/plugins/hermes-bots/roster-pane')

  return { default: mod.BotsPane }
})

/** Live host for the phone Sessions|Bots window. */
export function SessionsWindowHost({ onClose }: { onClose: () => void }) {
  const { t } = useI18n()
  const navigate = useNavigate()
  const [tab, setTab] = useState<SessionsWindowTab>('sessions')
  const profiles = useStore($profiles)
  const activeProfile = useStore($activeGatewayProfile)
  const colors = useStore($profileColors)
  const navItems = useMobileNavItems(onClose)

  const profileRows = useMemo<SessionsWindowProfile[]>(
    () =>
      profiles.map(p => ({
        color: resolveProfileColor(p.name, colors),
        id: p.name,
        isDefault: p.name === 'default',
        name: profileLabel(p)
      })),
    [colors, profiles]
  )

  // Same door as desktop wiring `onResumeSession`: seed the bubble strip, then
  // owner-aware resume + navigate. Do NOT call lifecycle `openSession` here —
  // `useRouteResume` is the single hydrator.
  const onResumeSession = useCallback(
    (sessionId: string, session?: SessionInfo) => {
      openStoredSessionInBubble(sessionId)
      resumeSessionIntoMain(sessionId, navigate, session)
    },
    [navigate]
  )

  useEffect(() => {
    const release = pushEscapeLayer(ESCAPE_PRIORITY.overlay)

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || !isTopEscapeLayer(ESCAPE_PRIORITY.overlay)) {
        return
      }

      event.preventDefault()
      onClose()
    }

    window.addEventListener('keydown', onKeyDown)
    logSessionsRoute('sessionsWindow_open', { tab: 'sessions' })

    return () => {
      release()
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose])

  useEffect(() => {
    $botsPaneVisible.set(tab === 'bots')

    return () => {
      $botsPaneVisible.set(false)
    }
  }, [tab])

  useEffect(() => {
    if (tab !== 'bots') {
      return
    }

    let skip = true

    return $openBotChat.subscribe(chat => {
      if (skip) {
        skip = false

        return
      }

      // Seed the strip the same way Sessions-tab resume does — without a second
      // resumeSessionIntoMain (SDK host.openSession already wakes the chat).
      if (chat?.openedSessionId) {
        openStoredSessionInBubble(chat.openedSessionId)
      }

      if (chat) {
        onClose()
      }
    })
  }, [onClose, tab])

  return (
    <div className="animate-in fade-in-0 absolute inset-0 z-50 overflow-hidden bg-(--ui-bg-sidebar) duration-150">
      <div className="h-full min-h-0">
        <SessionsWindow
          activeTab={tab}
          botsBody={
            <Suspense
              fallback={
                <div className="grid min-h-0 flex-1 place-items-center text-sm text-muted-foreground">
                  {t.common.loading}
                </div>
              }
            >
              <BotsPane />
            </Suspense>
          }
          navItems={navItems}
          onClose={onClose}
          onSelectProfile={selectProfile}
          onSelectTab={setTab}
          profiles={
            profileRows.length > 0
              ? profileRows
              : [{ color: null, id: 'default', isDefault: true, name: 'Default' }]
          }
          selectedProfileId={activeProfile || 'default'}
          sessionsBody={
            <SidebarScrollBody
              onNavigate={onClose}
              onResumeSession={onResumeSession}
              searchPlacement="bottom"
            />
          }
        />
      </div>
    </div>
  )
}
