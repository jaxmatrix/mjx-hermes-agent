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

// Compat root for `?win=activity` (MJX-141). Phone Settings / Command Center /
// Profiles / Cron now open as in-app SPA overlays on MainActivity
// (`openAppRoute` → MobileController → MobileSurfaceShell). This root remains
// for an old deep link that still lands on a ScreenActivity WebView.
//
// The chrome (Back · title-menu · surface) is shared with the in-app overlay.
// Back / open-session map to `returnHome` (finish the native scene). Without
// MobileGatewayHost this WebView only mirrors identity — prefer the SPA path.
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
