import { type VariantProps, cva } from 'class-variance-authority'
import * as React from 'react'

import { cn } from '@/lib/utils'

// The "columns scale with screen" pattern in one place. Mobile-first: every
// variant starts at 1 column and ADDS columns at larger breakpoints.
const grid = cva('grid gap-4 sm:gap-6', {
  variants: {
    cols: {
      1: 'grid-cols-1',
      2: 'grid-cols-1 md:grid-cols-2',
      3: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3',
      4: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-4'
    }
  },
  defaultVariants: { cols: 3 }
})

export function Grid({ cols, className, ...props }: React.ComponentProps<'div'> & VariantProps<typeof grid>) {
  return <div className={cn(grid({ cols }), className)} data-slot="grid" {...props} />
}
