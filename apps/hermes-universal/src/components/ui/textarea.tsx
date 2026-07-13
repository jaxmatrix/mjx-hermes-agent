import * as React from 'react'

import { type ControlVariantProps, controlVariants } from '@/components/ui/control'
import { cn } from '@/lib/utils'

// Ported from apps/desktop/src/components/ui/textarea.tsx — shares the control
// chrome (controlVariants). Autocorrect/spellcheck default off (these edit
// config/code/prompt text, not prose).
function Textarea({ className, size, ...props }: React.ComponentProps<'textarea'> & ControlVariantProps) {
  return (
    <textarea
      autoCapitalize="off"
      autoComplete="off"
      autoCorrect="off"
      className={cn(controlVariants({ size }), 'min-h-16', className)}
      data-slot="textarea"
      spellCheck={false}
      {...props}
    />
  )
}

export { Textarea }
