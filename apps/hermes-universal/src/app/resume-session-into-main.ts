/**
 * One door for "open this stored chat in the main pane" on surfaces that must
 * not call lifecycle `openSession` — the phone Sessions window, cold restore,
 * and MobileSurfaceShell. Owner-aware resume request, then `app/open-session`
 * navigate; `useRouteResume` is the single hydrator.
 */
import { openSession, type OpenSessionNavigate } from '@/app/open-session'
import { logSessionsRoute } from '@/lib/sessions-route-log'
import {
  forgetSessionOwnerHintsForSession,
  requestSessionResume,
  sessionOwnerRouteFromRow
} from '@/store/session'
import type { SessionInfo } from '@/types/hermes'

export function resumeSessionIntoMain(
  sessionId: string,
  navigate: OpenSessionNavigate,
  session?: SessionInfo
): void {
  if (!sessionId) {
    return
  }

  const ownerRoute = session ? sessionOwnerRouteFromRow(session) : undefined

  logSessionsRoute('resumeSessionIntoMain', {
    hasOwnerRoute: Boolean(ownerRoute),
    sessionId
  })

  if (ownerRoute) {
    requestSessionResume(sessionId, ownerRoute)
  } else {
    forgetSessionOwnerHintsForSession(sessionId)
    requestSessionResume(sessionId)
  }

  openSession(sessionId, navigate)
}
