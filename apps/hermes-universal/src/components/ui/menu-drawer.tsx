import { createContext, type ReactNode, useContext, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { TopDrawerRow } from '@/components/ui/top-drawer'
import { useI18n } from '@/i18n'
import { ChevronLeft } from '@/lib/icons'
import { cn } from '@/lib/utils'

import type { MenuItemProps, MenuKit, MenuSectionProps } from './actions-menu'

/**
 * A `MenuKit` that renders a menu as a bottom DRAWER, with submenus as PAGES.
 *
 * The menu itself is not rewritten. A caller already describes its rows once and
 * hands the description to `DROPDOWN_KIT` or `CONTEXT_KIT`; this is a third
 * flavour of the same seam, so a touch surface costs a kit rather than a second
 * copy of what the menu contains — which is how the two would drift apart.
 *
 * WHY PAGES AND NOT NESTING. A Radix submenu opens on HOVER, which a finger does
 * not have, and lands a second floating panel over the first. Here a submenu row
 * pushes its content as a page with a back button: one panel, full-width rows,
 * and the same gesture for every level.
 *
 * WHY BOTTOM. On the phone shell every action/context menu should land under the
 * thumb. Top drawers remain for chrome that hangs under a title bar; MenuDrawer
 * is the action-list path and always sheets from the bottom.
 */

interface DrawerPage {
  /** The submenu's `SubContent` className, carried through to the page.
   *
   *  A caller declares it once — `contentClassName: 'p-2'` on the Appearance
   *  spec, `className="p-2"` on the project menu's swatch submenu — and the two
   *  Radix kits put it on the floating panel. Here there is no second panel: the
   *  submenu IS the page, so the class belongs to it. Dropping it left the
   *  swatch grid with no side padding at all (drawer rows carry their own
   *  `px-4`; a custom body carries none), flush against both edges of the phone
   *  inside a panel that clips rather than scrolls sideways. */
  className?: string
  content: ReactNode
  title: string
}

interface MenuDrawerContext {
  close: () => void
  push: (page: DrawerPage) => void
}

const Ctx = createContext<MenuDrawerContext>({ close: () => {}, push: () => {} })

/** Pull the readable text out of a node tree.
 *
 *  A submenu's trigger is `<Codicon/><span>Label</span>`, and the page it pushes
 *  needs a TITLE — a string, not that tree. The kit only ever sees the rendered
 *  children (the spec that produced them belongs to the caller), so the label is
 *  recovered from them rather than threaded through every spec type. */
function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node)
  }

  if (Array.isArray(node)) {
    return node.map(textOf).join('')
  }

  if (node && typeof node === 'object' && 'props' in node) {
    return textOf((node as { props?: { children?: ReactNode } }).props?.children)
  }

  return ''
}

function DrawerItem({ children, className, disabled, onSelect, variant }: MenuItemProps) {
  const { close } = useContext(Ctx)

  if (disabled) {
    return (
      <div
        className={cn(
          'flex min-h-(--touch-target-min) w-full items-center gap-3 px-4 text-sm opacity-50',
          variant === 'destructive' && 'text-destructive',
          className
        )}
      >
        {children}
      </div>
    )
  }

  return (
    <TopDrawerRow
      onSelect={() => {
        // Radix hands `onSelect` a DOM event it can `preventDefault()` to keep
        // the menu open (voice toggles). Honour that here so a drawer toggle
        // does not slam shut the moment you flip it.
        const event = new Event('select', { cancelable: true })
        onSelect?.(event)

        if (!event.defaultPrevented) {
          close()
        }
      }}
    >
      <span className={cn('flex min-w-0 flex-1 items-center gap-3', variant === 'destructive' && 'text-destructive')}>
        {children}
      </span>
    </TopDrawerRow>
  )
}

/** Markers. `Sub` reads them off its own children; on their own they render
 *  nothing, which is why they never reach the DOM. */
function DrawerSubTrigger({ children }: MenuSectionProps) {
  return <>{children}</>
}

function DrawerSubContent({ children }: MenuSectionProps) {
  return <>{children}</>
}

function DrawerSub({ children }: MenuSectionProps) {
  const { push } = useContext(Ctx)
  const parts = Array.isArray(children) ? children : [children]

  const trigger = parts.find(
    (part): part is { props: { children?: ReactNode }; type: unknown } =>
      !!part && typeof part === 'object' && 'type' in part && part.type === DrawerSubTrigger
  )

  const content = parts.find(
    (part): part is { props: { children?: ReactNode; className?: string }; type: unknown } =>
      !!part && typeof part === 'object' && 'type' in part && part.type === DrawerSubContent
  )

  const label = textOf(trigger?.props?.children)

  return (
    <TopDrawerRow
      onSelect={() => push({ className: content?.props?.className, content: content?.props?.children, title: label })}
    >
      <span className="flex min-w-0 flex-1 items-center gap-3">{trigger?.props?.children}</span>
      <Codicon className="shrink-0 opacity-60 rtl:-scale-x-100" name="chevron-right" size="0.875rem" />
    </TopDrawerRow>
  )
}

function DrawerLabel({ children, className }: MenuSectionProps) {
  return (
    <p
      className={cn('px-4 pt-3 pb-1 text-xs font-medium tracking-wide text-(--ui-text-tertiary) uppercase', className)}
    >
      {children}
    </p>
  )
}

function DrawerSeparator() {
  return <div aria-hidden className="my-1 h-px bg-border/65" />
}

export const DRAWER_KIT: MenuKit = {
  Item: DrawerItem as MenuKit['Item'],
  Label: DrawerLabel as MenuKit['Label'],
  Separator: DrawerSeparator as MenuKit['Separator'],
  Sub: DrawerSub as MenuKit['Sub'],
  SubContent: DrawerSubContent as MenuKit['SubContent'],
  SubTrigger: DrawerSubTrigger as MenuKit['SubTrigger'],
  copyAppearance: 'menu-item'
}

/**
 * Host a kit-rendered menu in a bottom drawer.
 *
 * Owns the page stack so `DRAWER_KIT` can push from anywhere inside the tree
 * without the caller threading state through its spec list.
 */
export function MenuDrawer({
  onOpenChange,
  open,
  render,
  title
}: {
  onOpenChange: (open: boolean) => void
  open: boolean
  render: (kit: MenuKit) => ReactNode
  title: string
}) {
  const common = useI18n().t.common
  const [page, setPage] = useState<DrawerPage | null>(null)

  const close = () => {
    onOpenChange(false)
    // Reset on the way out — reopening into a page you left behind reads as the
    // drawer having remembered the wrong thing.
    setPage(null)
  }

  const heading = page ? page.title : title

  return (
    <Ctx.Provider value={{ close, push: setPage }}>
      <Sheet onOpenChange={next => (next ? onOpenChange(true) : close())} open={open}>
        <SheetContent
          className={cn(
            'flex max-h-[min(75vh,var(--visual-viewport-height,100vh))] flex-col gap-0 rounded-t-xl p-0',
            'pb-[max(0.5rem,var(--safe-area-inset-bottom,0px))]',
            'outline-none focus:outline-none focus-visible:outline-none',
            // Lift above the soft keyboard when it is up (portal lives on body).
            'keyboard-open:mb-[var(--keyboard-inset,0px)]'
          )}
          data-menu-drawer
          onOpenAutoFocus={event => {
            event.preventDefault()
            ;(event.currentTarget as HTMLElement | null)?.focus?.()
          }}
          showCloseButton={false}
          side="bottom"
        >
          <div className="flex shrink-0 items-center gap-2 border-b border-border/65 px-2 py-1.5">
            {page ? (
              <Button aria-label={common.back} onClick={() => setPage(null)} size="icon" type="button" variant="ghost">
                <ChevronLeft className="size-5" />
              </Button>
            ) : null}
            <SheetTitle className="min-w-0 flex-1 truncate px-2 text-sm font-medium">{heading}</SheetTitle>
            <Button aria-label={common.close} onClick={close} size="icon" type="button" variant="ghost">
              <Codicon name="close" size="1rem" />
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1">
            {/* The page is where a submenu's `SubContent` class lands — the one
                element that stands for that submenu's body on this flavour. The
                markers stay markers; they never reach the DOM. */}
            {page ? <div className={page.className}>{page.content}</div> : open ? render(DRAWER_KIT) : null}
          </div>
        </SheetContent>
      </Sheet>
    </Ctx.Provider>
  )
}
