import { createContext, type ReactNode, useContext, useMemo, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'

import { Button } from '@/components/ui/button'
import { Sheet, SheetContent } from '@/components/ui/sheet'
import { Menu } from '@/lib/icons'
import { cn } from '@/lib/utils'

import { useNavItems } from './nav-items'

// Nav is a deliberate shared-content / two-presentations split (responsive
// discipline #5): the SAME SidebarNav renders as a persistent rail on md+ and a
// Sheet drawer on phones, toggled by a SidebarTrigger that screens host in their
// own header (so there's a single header per screen — no shell/screen double bar).

interface SidebarCtx {
  openMobile: boolean
  setOpenMobile: (v: boolean) => void
  toggle: () => void
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
    () => ({ openMobile, setOpenMobile, toggle: () => setOpenMobile(v => !v) }),
    [openMobile]
  )
  return <SidebarContext.Provider value={value}>{children}</SidebarContext.Provider>
}

/** Hamburger. Screens drop this into their own header (usually `md:hidden`). */
export function SidebarTrigger({ className }: { className?: string }) {
  const { toggle } = useSidebar()
  return (
    <Button aria-label="Open navigation" className={className} onClick={toggle} size="icon-sm" variant="ghost">
      <Menu className="size-5" />
    </Button>
  )
}

function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const { pathname } = useLocation()
  const navItems = useNavItems()
  return (
    <nav aria-label="Primary" className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-2">
      <div className="px-3 py-3 text-sm font-bold tracking-[0.18em] text-primary uppercase">Hermes</div>
      {navItems.map(item => {
        const active = item.path === '/' ? pathname === '/' : pathname.startsWith(item.path)
        const Icon = item.icon
        return (
          <Link
            key={item.view}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
              active && 'bg-accent text-foreground'
            )}
            onClick={onNavigate}
            to={item.path}
          >
            <Icon className="size-5 shrink-0" />
            {item.label}
          </Link>
        )
      })}
    </nav>
  )
}

/** The responsive frame: rail on md+, drawer on phones, one main content slot. */
export function AppShell({ children }: { children: ReactNode }) {
  const { openMobile, setOpenMobile } = useSidebar()
  return (
    <div className="flex h-full min-h-0">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-border bg-card md:flex">
        <SidebarNav />
      </aside>

      <Sheet onOpenChange={setOpenMobile} open={openMobile}>
        <SheetContent className="w-72 gap-0 p-0" side="left">
          <SidebarNav onNavigate={() => setOpenMobile(false)} />
        </SheetContent>
      </Sheet>

      <main className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</main>
    </div>
  )
}
