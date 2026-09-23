import { connectionColor, connectionColorSoft } from '@/lib/connection-color'
import { cn } from '@/lib/utils'

/**
 * WHICH CONNECTION a chat belongs to, as colour (MJXHRM-591, the owner's
 * ruling: colour, never a text chip).
 *
 * A tab strip has room for a dot and a chat top bar for a 3 px rule; neither
 * costs a translation, neither truncates, and both read at a glance in a
 * four-pane layout. The hue is a pure function of the connection id
 * (`lib/connection-color`), so nothing is persisted and every window agrees.
 *
 * The LOCAL connection is deliberately neutral — it is the connection a
 * single-source user has, and marking it would put a colour on every tab in an
 * app with one backend.
 */
export function ConnectionDot({ className, connectionId }: { className?: string; connectionId: null | string }) {
  const color = connectionColor(connectionId)

  if (!color) {
    return null
  }

  return (
    <span
      aria-hidden
      className={cn('size-1.5 shrink-0 rounded-full', className)}
      data-testid="connection-dot"
      style={{ backgroundColor: color, boxShadow: `0 0 0 2px ${connectionColorSoft(color, 22)}` }}
    />
  )
}

/** The leading rule down the start edge of a chat's top bar. `start`, not
 *  `left`: RTL mirrors it with the rest of the bar. */
export function ConnectionBar({ className, connectionId }: { className?: string; connectionId: null | string }) {
  const color = connectionColor(connectionId)

  if (!color) {
    return null
  }

  return (
    <span
      aria-hidden
      className={cn('absolute inset-y-0 start-0 w-[3px] rounded-e-full', className)}
      data-testid="connection-bar"
      style={{ backgroundColor: color }}
    />
  )
}
