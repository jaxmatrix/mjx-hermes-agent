import { type VariantProps, cva } from 'class-variance-authority'
import * as React from 'react'

import { cn } from '@/lib/utils'

// Owns horizontal padding + max width across screens so pages don't repeat it.
// Mobile-first: base padding for phones, additive `sm:`/`lg:` bumps only.
const container = cva('mx-auto w-full px-4 sm:px-6 lg:px-8', {
  variants: {
    size: {
      default: 'max-w-6xl',
      prose: 'max-w-2xl',
      full: 'max-w-none'
    }
  },
  defaultVariants: { size: 'default' }
})

export function Container({
  size,
  className,
  ...props
}: React.ComponentProps<'div'> & VariantProps<typeof container>) {
  return <div className={cn(container({ size }), className)} data-slot="container" {...props} />
}
