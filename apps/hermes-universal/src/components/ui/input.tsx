import * as React from 'react'

import { cn } from '@/lib/utils'

import { type ControlVariantProps, controlVariants } from './control'

// Ported from apps/desktop/src/components/ui/input.tsx against the adapted
// controlVariants. Autofill/spellcheck are off by default (these are
// code/config/search fields, not prose); callers re-enable per instance.
function Input({ className, type, size, ...props }: Omit<React.ComponentProps<'input'>, 'size'> & ControlVariantProps) {
  return (
    <input
      autoCapitalize="off"
      autoComplete="off"
      autoCorrect="off"
      className={cn(
        controlVariants({ size }),
        'selection:bg-primary selection:text-primary-foreground file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground',
        className
      )}
      data-slot="input"
      spellCheck={false}
      type={type}
      {...props}
    />
  )
}

export { Input }
