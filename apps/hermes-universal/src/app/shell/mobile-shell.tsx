import { WiredPane } from '@/app/contrib'
import { useKeyboardInset } from '@/hooks/use-keyboard-inset'

import { useRestoreLastSession } from './hooks/use-restore-last-session'
import { MobileTopBar } from './mobile-top-bar'
import { SessionsWindowHost } from './sessions-window-host'
import { useSidebar } from './sidebar'
import { WorkspaceWindowHost } from './workspace-window-host'

// The root mobile layout. A phone takes this branch (IS_MOBILE) instead of the
// docked tile tree. Left = Sessions|Bots window; right = Workspace (Control +
// tool tabs). Chat is desktop ChatView via ContribWiring → WiredPane chatRoutes.
//
// Soft keyboard: `html.is-mobile #root` is pinned to the VISIBLE viewport
// (styles.css), so this column needs no --keyboard-inset margin.
//
// SIDEBAR_NAV (New / Caps / Messaging / …) lives as a horizontal rail on the
// left Sessions window only — not on this chat surface.
//
// WorkspaceWindowHost is a static import on purpose: `lazy(() => import(...))`
// Suspense-gated the whole overlay behind a Vite chunk that 404s on Android
// `tauri android dev` (stuck full-screen Loading, no host mount).

export function MobileShell() {
  useKeyboardInset()
  useRestoreLastSession()
  const { openMobile, setOpenMobile, openMobileRight, setOpenMobileRight } = useSidebar()

  return (
    <div
      className="relative flex h-full min-h-0 flex-col bg-background"
      data-slot="mobile-shell"
      // Horizontal insets only — MobileTopBar owns top, composer owns bottom.
      // Matches MobileWindowChrome so chat/thread stay inside the safe rectangle.
      style={{
        paddingLeft: 'var(--safe-area-inset-left, 0px)',
        paddingRight: 'var(--safe-area-inset-right, 0px)'
      }}
    >
      <MobileTopBar />

      <div className="flex min-h-0 flex-1 flex-col">
        <WiredPane part="chatRoutes" />
      </div>

      {openMobile && <SessionsWindowHost onClose={() => setOpenMobile(false)} />}

      {openMobileRight && <WorkspaceWindowHost onClose={() => setOpenMobileRight(false)} />}
    </div>
  )
}
