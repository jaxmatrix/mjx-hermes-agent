import type * as React from 'react'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { Tip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

interface GenerateButtonProps extends Omit<React.ComponentProps<typeof Button>, 'children' | 'onClick'> {
  /** True while a generation is in flight. */
  generating: boolean
  /** Start a generation. */
  onGenerate: () => void
  /** Tooltip + aria label at rest. */
  label: string
  /** Tooltip while generating (e.g. "Generating…"). Falls back to `label`. */
  generatingLabel?: string
  iconSize?: number | string
}

// The sparkle "generate with AI" affordance — icon + tooltip. Ported/adapted from
// desktop `components/ui/generate-button.tsx`; the universal one-shot can't be
// cancelled, so the sparkle just spins until it resolves.
export function GenerateButton({
  generating,
  onGenerate,
  label,
  generatingLabel,
  disabled,
  iconSize = 12,
  className,
  ...rest
}: GenerateButtonProps) {
  const tip = generating ? generatingLabel ?? label : label

  return (
    <Tip label={tip}>
      <Button
        aria-label={tip}
        className={cn('size-6 text-muted-foreground/80 hover:text-foreground', className)}
        disabled={generating || disabled}
        onClick={onGenerate}
        size="icon-xs"
        type="button"
        variant="ghost"
        {...rest}
      >
        <Codicon className={generating ? 'animate-pulse' : undefined} name="sparkle" size={iconSize} />
      </Button>
    </Tip>
  )
}
