import { useCallback } from 'react'

import { MobileSurfaceShell } from '@/app/shell/mobile-surface-shell'
import { SidebarProvider } from '@/app/shell/sidebar'
import { NotificationStack } from '@/components/notifications'
import { DesktopOnboardingOverlay } from '@/components/onboarding'
import { useKeyboardInset } from '@/hooks/use-keyboard-inset'
import { useStore } from '@/store/atom'
import { requestGateway } from '@/store/gateway-client'
import { $activeGatewayProfile } from '@/store/profile'
import { returnHome } from '@/store/windows'

// Native activity-screen root (MJX-141). On Android, the windowable surfaces
// (Settings / Command Center / Profiles / Cron) open in ONE native screen activity (a
// fresh WebView carrying `?win=activity`, launched from `src-tauri/src/window.rs`).
// `app.tsx` mounts this instead of the full chat shell (MobileController).
//
// The chrome (Back · title-menu · surface, derived live from the route) lives in the
// shared `MobileSurfaceShell` so the iOS / generic-mobile in-app overlay
// (mobile-controller) renders these surfaces with the exact same layout (MJX-203).
// Here the Back / open-session actions map to `returnHome` (finish the native scene →
// back to the sessions activity), which is also what the hardware back key does.
//
// The WebView shares the single Rust core, but its JS/connection is fresh:
// `main.tsx` auto-reconnects on boot, so — like SecondaryWindowRoot —
// `MobileSurfaceShell` waits for `$connectionPhase` before rendering the surface.
export function ActivityScreenRoot() {
  // Publishes the visual-viewport vars `html.is-mobile #root` is sized from
  // (styles.css). Mounted HERE rather than left to `MobileSurfaceShell`: the
  // DesktopOnboardingOverlay (mounted below) can hold API-key fields that move
  // the visual viewport.
  useKeyboardInset()

  // Opening a session belongs in the main chat activity, so "open session" here just
  // returns Home (the sessions activity) rather than routing within this scene.
  const goHome = useCallback(() => {
    void returnHome()
  }, [])

  const activeProfile = useStore($activeGatewayProfile)

  // Settings ▸ Providers lives on this surface; desktop's onboarding overlay owns
  // first-run and manual provider connect (same as MobileController / wiring).
  return (
    <SidebarProvider>
      <MobileSurfaceShell onHome={goHome} onOpenSession={goHome} />
      <DesktopOnboardingOverlay enabled profile={activeProfile} requestGateway={requestGateway} />
      <NotificationStack />
    </SidebarProvider>
  )
}
