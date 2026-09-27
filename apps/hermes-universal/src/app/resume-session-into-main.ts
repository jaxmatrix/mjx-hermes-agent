/**
 * One door for "open this stored chat in the main pane" on surfaces that must
 * not call lifecycle `openSession` — the phone Sessions window, cold restore,
 * and MobileSurfaceShell. Owner-aware resume request, then `app/open-session`
 * navigate; `useRouteResume` is the single hydrator.
 *
 * On phone, intent is `'main'` so navigate always runs (in-place can skip when
 * selection already matches while the hash is still on another session).
 */
import { openSession, type OpenSessionNavigate } from '@/app/open-session'
import { IS_MOBILE } from '@/lib/platform'
import { logSessionsRoute } from '@/lib/sessions-route-log'
import {
  forgetSessionOwnerHintsForSession,
  requestSessionResume,
  sessionOwnerRouteFromRow
} from '@/store/session'
import { sessionRowFor } from '@/store/session-lookup'
import type { SessionInfo } from '@/types/hermes'

export function resumeSessionIntoMain(
  sessionId: string,
  navigate: OpenSessionNavigate,
  session?: SessionInfo
): void {
  if (!sessionId) {
    return
  }

  // Overlays often only have an id — resolve the row so cross-connection
  // owner routes still ride into useRouteResume.
  const row = session ?? sessionRowFor(sessionId) ?? undefined
  const ownerRoute = row ? sessionOwnerRouteFromRow(row) : undefined

  logSessionsRoute('resumeSessionIntoMain', {
    hasOwnerRoute: Boolean(ownerRoute),
    resolvedRow: Boolean(row),
    sessionId
  })

  if (ownerRoute) {
    requestSessionResume(sessionId, ownerRoute)
  } else {
    forgetSessionOwnerHintsForSession(sessionId)
    requestSessionResume(sessionId)
  }

  openSession(sessionId, navigate, IS_MOBILE ? 'main' : 'in-place')
}
