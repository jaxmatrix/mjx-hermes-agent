import { createContext, type ReactNode, useContext, useMemo, useState } from 'react'

import { ChatSidebar } from '@/app/chat/sidebar'
import { Pane, PaneMain, PaneShell } from '@/components/pane-shell'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent } from '@/components/ui/sheet'
import { useMediaQuery } from '@/hooks/use-media-query'
import { Menu } from '@/lib/icons'
import { IS_DESKTOP } from '@/lib/platform'
import { cn } from '@/lib/utils'
import { useStore } from '@/store/atom'
import {
  CHAT_SIDEBAR_PANE_ID,
  $panesFlipped,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  setSidebarOverlayMounted
} from '@/store/layout'

// The rich chat sidebar (ported from desktop) renders as a resizable/hover-reveal
// docked PANE on md+ and as a left `Sheet` DRAWER on phones — one shared
// <ChatSidebar>, two presentations (responsive discipline #5). Below this
// breakpoint the drawer takes over, so the pane never needs desktop's
// force-collapse; the pane's own hover-reveal covers the toggle-closed case.
const SIDEBAR_WIDE_MEDIA_QUERY = '(min-width: 768px)'

interface SidebarCtx {
  openMobile: boolean
  setOpenMobile: (v: boolean) => void
  toggleMobile: () => void
}

const SidebarContext = createContext<SidebarCtx | null>(null)

export function useSidebar(): SidebarCtx {
  const ctx = useContext(SidebarContext)
  if (!ctx) throw new Error('useSidebar must be used within <SidebarProvider>')
  return ctx
}

export function SidebarProvider({ children }: { children: ReactNode }) {
  const [openMobile, setOpenMobile] = useState(false)
  const value = useMemo<SidebarCtx>(
    () => ({ openMobile, setOpenMobile, toggleMobile: () => setOpenMobile(v => !v) }),
    [openMobile]
  )
  return <SidebarContext.Provider value={value}>{children}</SidebarContext.Provider>
}

/** Hamburger that opens the phone drawer. Screens drop this into their own header (usually `md:hidden`). */
export function SidebarTrigger({ className }: { className?: string }) {
  const { toggleMobile } = useSidebar()
  return (
    <Button aria-label="Open navigation" className={className} onClick={toggleMobile} size="icon-sm" variant="ghost">
      <Menu className="size-5" />
    </Button>
  )
}

/** The responsive frame: docked pane on md+, drawer on phones, one main slot. */
export function AppShell({ children }: { children: ReactNode }) {
  const wide = useMediaQuery(SIDEBAR_WIDE_MEDIA_QUERY)
  const { openMobile, setOpenMobile } = useSidebar()
  const panesFlipped = useStore($panesFlipped)

  if (!wide) {
    return (
      <div className="flex h-full min-h-0">
        <main className="flex min-h-0 min-w-0 flex-1 flex-col pt-[env(safe-area-inset-top)]">{children}</main>

        <Sheet onOpenChange={setOpenMobile} open={openMobile}>
          <SheetContent className="w-[19rem] gap-0 p-0" side="left">
            <ChatSidebar onNavigate={() => setOpenMobile(false)} variant="sheet" />
          </SheetContent>
        </Sheet>
      </div>
    )
  }

  return (
    <PaneShell className="h-full">
      <Pane
        defaultOpen
        hoverReveal
        id={CHAT_SIDEBAR_PANE_ID}
        maxWidth={SIDEBAR_MAX_WIDTH}
        minWidth={SIDEBAR_DEFAULT_WIDTH}
        onOverlayActiveChange={setSidebarOverlayMounted}
        overlayWidth={SIDEBAR_DEFAULT_WIDTH}
        resizable
        side={panesFlipped ? 'right' : 'left'}
        width={SIDEBAR_DEFAULT_WIDTH}
      >
        <ChatSidebar variant="pane" />
      </Pane>

      <PaneMain>
        {/* Push routed content below the transparent titlebar overlay on desktop
            Tauri; the pane background still reaches y=0 so the division shows. */}
        <div className={cn('flex min-h-0 flex-1 flex-col', IS_DESKTOP && 'pt-(--titlebar-height)')}>{children}</div>
      </PaneMain>
    </PaneShell>
  )
}
