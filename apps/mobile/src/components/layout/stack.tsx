import { type VariantProps, cva } from 'class-variance-authority'
import * as React from 'react'

import { cn } from '@/lib/utils'

// Flex stack with owned spacing. Mobile-first: `row` stacks on phones and only
// becomes a row from `md` up (an ADD, never a max-* walkback).
const stack = cva('flex', {
  variants: {
    direction: {
      col: 'flex-col',
      row: 'flex-col md:flex-row'
    },
    gap: {
      0: 'gap-0',
      1: 'gap-1',
      2: 'gap-2',
      3: 'gap-3',
      4: 'gap-4',
      6: 'gap-6',
      8: 'gap-8'
    },
    align: {
      start: 'items-start',
      center: 'items-center',
      end: 'items-end',
      stretch: 'items-stretch'
    }
  },
  defaultVariants: { direction: 'col', gap: 4 }
})

export function Stack({
  direction,
  gap,
  align,
  className,
  ...props
}: React.ComponentProps<'div'> & VariantProps<typeof stack>) {
  return <div className={cn(stack({ direction, gap, align }), className)} data-slot="stack" {...props} />
}
