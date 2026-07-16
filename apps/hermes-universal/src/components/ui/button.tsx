import { cva, type VariantProps } from 'class-variance-authority'
import { Slot } from 'radix-ui'
import * as React from 'react'

import { cn } from '@/lib/utils'

// Adapted from apps/desktop/src/components/ui/button.tsx: same exports, variant
// names, and size names (so ported desktop code is drop-in) but re-tuned for
// touch — 44px default targets, larger radius/text — and keyed to the A2 named
// token contract (bg-primary/secondary/accent/destructive) instead of the
// desktop chrome/titlebar tokens. Desktop-only sizes (icon-titlebar) are dropped.
const TEXT_ACTION_ICON = '[&_svg]:no-underline'

const buttonVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-md text-sm font-medium whitespace-nowrap transition-all duration-100 outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-default disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        destructive: 'bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/30',
        outline: 'border border-input bg-transparent text-foreground hover:bg-accent hover:text-accent-foreground',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        ghost: 'text-foreground hover:bg-accent hover:text-accent-foreground',
        link: `text-primary underline-offset-4 hover:underline ${TEXT_ACTION_ICON}`,
        // Boxless inline-text action (no bg/border) — muted label, underlines on hover.
        text: `text-muted-foreground underline-offset-4 hover:text-foreground hover:underline ${TEXT_ACTION_ICON}`,
        // Emphasized inline-text action: bold + always-underlined.
        textStrong: `font-semibold text-muted-foreground underline underline-offset-4 hover:text-foreground ${TEXT_ACTION_ICON}`
      },
      size: {
        default: 'h-11 gap-2 px-4 py-2 has-[>svg]:px-3',
        xs: "h-8 gap-1 px-2.5 text-xs has-[>svg]:px-2 [&_svg:not([class*='size-'])]:size-3.5",
        sm: 'h-9 px-3 has-[>svg]:px-2.5',
        lg: 'h-12 px-6 text-base has-[>svg]:px-5',
        // Flush inline text action — no box padding/height.
        inline: 'h-auto gap-1 p-0 has-[>svg]:px-0',
        // Compact 12px text action beside a label.
        micro:
          "h-auto gap-0.5 px-1 py-0 text-xs font-normal has-[>svg]:px-0.5 [&_svg:not([class*='size-'])]:size-3.5",
        icon: 'size-11',
        'icon-xs': "size-8 [&_svg:not([class*='size-'])]:size-4",
        'icon-sm': 'size-9',
        'icon-lg': 'size-12',
        // Compact overlay/titlebar control (ported from apps/desktop) — the settings
        // portal close button. Sized off the titlebar-control tokens.
        'icon-titlebar':
          'h-(--titlebar-control-height) w-(--titlebar-control-size) rounded-[4px] [&_.codicon]:text-[0.875rem]'
      }
    },
    compoundVariants: [
      // textStrong is a boxless link — strip any injected inline padding.
      { variant: 'textStrong', class: 'px-0 has-[>svg]:px-0' }
    ],
    defaultVariants: {
      variant: 'default',
      size: 'default'
    }
  }
)

function Button({
  className,
  variant = 'default',
  size = 'default',
  asChild = false,
  ...props
}: React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : 'button'

  return (
    <Comp
      className={cn(buttonVariants({ variant, size }), className)}
      data-size={size}
      data-slot="button"
      data-variant={variant}
      {...props}
    />
  )
}

export { Button, buttonVariants }
