import * as React from 'react'
import { useState } from 'react'

import { Codicon } from '@/components/ui/codicon'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { MenuDrawer } from '@/components/ui/menu-drawer'
import { IS_MOBILE } from '@/lib/platform'

// One place to define a set of actions and get BOTH a kebab dropdown and a
// matching right-click context menu — so a row's ⋯ menu and its right-click menu
// never drift. The dropdown and context primitives share an identical item
// surface (Item / Separator / Sub…), so a caller writes `items={kit => …}` once
// and hands the render function to both wrappers.
//
// On phones the same `items` render feeds `MenuDrawer` (bottom sheet + pages)
// instead of a floating Radix menu — one description, three surfaces.

/** A menu flavour (dropdown / context) — the item + separator + submenu parts. */
export interface MenuKit {
  Item: typeof DropdownMenuItem | typeof ContextMenuItem
  Label: typeof DropdownMenuLabel | typeof ContextMenuLabel
  Separator: typeof DropdownMenuSeparator | typeof ContextMenuSeparator
  Sub: typeof DropdownMenuSub | typeof ContextMenuSub
  SubTrigger: typeof DropdownMenuSubTrigger | typeof ContextMenuSubTrigger
  SubContent: typeof DropdownMenuSubContent | typeof ContextMenuSubContent
  /** `CopyButton`'s `appearance` for this flavour — pass to a menu-item copy. */
  copyAppearance: 'context-menu-item' | 'menu-item'
}

export const DROPDOWN_KIT: MenuKit = {
  Item: DropdownMenuItem,
  Label: DropdownMenuLabel,
  Separator: DropdownMenuSeparator,
  Sub: DropdownMenuSub,
  SubContent: DropdownMenuSubContent,
  SubTrigger: DropdownMenuSubTrigger,
  copyAppearance: 'menu-item'
}

export const CONTEXT_KIT: MenuKit = {
  Item: ContextMenuItem,
  Label: ContextMenuLabel,
  Separator: ContextMenuSeparator,
  Sub: ContextMenuSub,
  SubContent: ContextMenuSubContent,
  SubTrigger: ContextMenuSubTrigger,
  copyAppearance: 'context-menu-item'
}

/** Drawer kit item surface — mirrors Radix menu item props without importing Radix here. */
export interface MenuItemProps {
  children?: React.ReactNode
  className?: string
  disabled?: boolean
  onSelect?: (event: Event) => void
  variant?: 'default' | 'destructive'
}

export interface MenuSectionProps {
  children?: React.ReactNode
  className?: string
}

/** A single action row. Provide `icon` (codicon name) or `iconNode` (any node). */
export interface ActionItemSpec {
  className?: string
  disabled?: boolean
  icon?: string
  iconNode?: React.ReactNode
  /** Stable key; defaults to `label` when it's a string. */
  key?: string
  label: React.ReactNode
  onSelect: (event: Event) => void
  variant?: 'default' | 'destructive'
}

/** Render one `ActionItemSpec` with the given kit's Item component. */
export function renderActionItem(
  kit: MenuKit,
  { className, disabled, icon, iconNode, key, label, onSelect, variant }: ActionItemSpec
) {
  return (
    <kit.Item
      className={className}
      disabled={disabled}
      key={key ?? (typeof label === 'string' ? label : undefined)}
      onSelect={onSelect}
      variant={variant}
    >
      {iconNode ?? (icon ? <Codicon name={icon} size="0.875rem" /> : null)}
      {typeof label === 'string' ? <span>{label}</span> : label}
    </kit.Item>
  )
}

interface ActionsMenuProps extends Pick<
  React.ComponentProps<typeof DropdownMenuContent>,
  'align' | 'side' | 'sideOffset' | 'onCloseAutoFocus'
> {
  /** The trigger (a kebab button). Wrapped in `DropdownMenuTrigger asChild`. */
  children: React.ReactNode
  /** The action rows, rendered with `DROPDOWN_KIT`. Share this with `ActionsContextMenu`. */
  items: (kit: MenuKit) => React.ReactNode
  ariaLabel?: string
  contentClassName?: string
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

// Let the existing presence boundary decide when item construction is needed.
// Calling `items` in the wrapper builds every closed row menu on each refresh.
function ActionItems({ items, kit }: { items: ActionsMenuProps['items']; kit: MenuKit }) {
  return <>{items(kit)}</>
}

function useDrawerOpen(controlled: boolean | undefined, onOpenChange?: (open: boolean) => void) {
  const [uncontrolled, setUncontrolled] = useState(false)
  const open = controlled ?? uncontrolled

  const setOpen = (next: boolean) => {
    if (controlled === undefined) {
      setUncontrolled(next)
    }

    onOpenChange?.(next)
  }

  return [open, setOpen] as const
}

function cloneTrigger(
  children: React.ReactNode,
  handlers: {
    onClick?: (event: React.MouseEvent) => void
    onContextMenu?: (event: React.MouseEvent) => void
  }
) {
  const child = React.Children.only(children) as React.ReactElement<{
    onClick?: (event: React.MouseEvent) => void
    onContextMenu?: (event: React.MouseEvent) => void
  }>

  return React.cloneElement(child, {
    onClick: (event: React.MouseEvent) => {
      child.props.onClick?.(event)
      handlers.onClick?.(event)
    },
    onContextMenu: (event: React.MouseEvent) => {
      child.props.onContextMenu?.(event)
      handlers.onContextMenu?.(event)
    }
  })
}

/**
 * A kebab dropdown menu. Pair it with `ActionsContextMenu` using the same
 * `items` render function so the two menus stay identical. No tip on the
 * trigger — `aria-label` on the button is enough (see DESIGN.md).
 *
 * On mobile the same items open a bottom `MenuDrawer` instead of a floating menu.
 */
export function ActionsMenu({
  align = 'end',
  ariaLabel,
  children,
  contentClassName,
  items,
  onCloseAutoFocus,
  onOpenChange,
  open: openProp,
  side,
  sideOffset = 6
}: ActionsMenuProps) {
  const [open, setOpen] = useDrawerOpen(openProp, onOpenChange)

  if (IS_MOBILE) {
    return (
      <>
        {cloneTrigger(children, { onClick: () => setOpen(true) })}
        <MenuDrawer onOpenChange={setOpen} open={open} render={items} title={ariaLabel ?? ''} />
      </>
    )
  }

  return (
    <DropdownMenu onOpenChange={onOpenChange} open={openProp}>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent
        align={align}
        aria-label={ariaLabel}
        className={contentClassName}
        onCloseAutoFocus={onCloseAutoFocus}
        side={side}
        sideOffset={sideOffset}
      >
        <ActionItems items={items} kit={DROPDOWN_KIT} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

interface ActionsContextMenuProps {
  /** The area that receives right-click. Wrapped in `ContextMenuTrigger asChild`. */
  children: React.ReactNode
  /** The action rows, rendered with `CONTEXT_KIT`. Share this with `ActionsMenu`. */
  items: (kit: MenuKit) => React.ReactNode
  ariaLabel?: string
  contentClassName?: string
  /** Skip the wrapper (render children bare) — e.g. nothing is actionable yet. */
  disabled?: boolean
  onCloseAutoFocus?: (event: Event) => void
}

/**
 * Wrap a row so right-clicking it opens the same menu as its kebab. Pass the
 * kebab's `items` render function so both surfaces mirror each other.
 *
 * On mobile, long-press / contextmenu opens the bottom `MenuDrawer` instead.
 */
export function ActionsContextMenu({
  ariaLabel,
  children,
  contentClassName,
  disabled,
  items,
  onCloseAutoFocus
}: ActionsContextMenuProps) {
  const [open, setOpen] = useDrawerOpen(undefined)

  if (disabled) {
    return <>{children}</>
  }

  if (IS_MOBILE) {
    return (
      <>
        {cloneTrigger(children, {
          onContextMenu: event => {
            event.preventDefault()
            setOpen(true)
          }
        })}
        <MenuDrawer onOpenChange={setOpen} open={open} render={items} title={ariaLabel ?? ''} />
      </>
    )
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent aria-label={ariaLabel} className={contentClassName} onCloseAutoFocus={onCloseAutoFocus}>
        <ActionItems items={items} kit={CONTEXT_KIT} />
      </ContextMenuContent>
    </ContextMenu>
  )
}
