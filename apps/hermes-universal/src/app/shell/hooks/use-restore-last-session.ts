import { useEffect, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router'

import { resumeSessionIntoMain } from '@/app/resume-session-into-main'
import { resolveSessionLanding } from '@/app/session-landing'
import { $hasConnected } from '@/store/connection'
import { $gatewayState } from '@/store/session'
import { $activeStoredSessionId, lastOpenedSessionId } from '@/store/session-lifecycle'

// Land on the chat you were last in, not an empty one.
//
// A phone cold-starts at "/" every time: there is no window state to restore and
// no address bar to come back to, so the app always opened on a blank new
// session and the conversation you were in the middle of was three taps deep in
// the sidebar. `store/session-lifecycle` records the last real session id on
// every switch; this spends it, once.
//
// SoftSwitch marks the socket open + hasConnected without always going through
// the legacy `$connectionPhase === 'ready'` path — gate on those live facts.
// Fire ONCE per launch: a later reconnect must not yank the user out of a chat
// they opened after connect.
//
// Navigate only — do NOT call lifecycle `openSession`. `useRouteResume` (via
// ContribWiring) is the single hydrator; see SessionsWindowHost.
export function useRestoreLastSession(): void {
  const navigate = useNavigate()
  const done = useRef(false)
  const { pathname } = useLocation()
  const pathnameRef = useRef(pathname)
  pathnameRef.current = pathname

  useEffect(() => {
    if (done.current) {
      return
    }

    const tryRestore = () => {
      if (done.current) {
        return
      }

      if ($gatewayState.get() !== 'open' || !$hasConnected.get()) {
        return
      }

      const landing = resolveSessionLanding(pathnameRef.current, lastOpenedSessionId())

      // Definitive non-restore outcomes — burn the latch only after the landing
      // check. Burning before it permanently skipped a later `/` restore when
      // an early tick was not yet `remembered`.
      if (landing.kind === 'route' || landing.kind === 'elsewhere' || landing.kind === 'new') {
        done.current = true

        return
      }

      if ($activeStoredSessionId.get()) {
        done.current = true

        return
      }

      done.current = true
      resumeSessionIntoMain(landing.id, navigate)
    }

    tryRestore()

    const unsubGateway = $gatewayState.subscribe(tryRestore)
    const unsubConnected = $hasConnected.subscribe(tryRestore)

    return () => {
      unsubGateway()
      unsubConnected()
    }
  }, [navigate])
}
