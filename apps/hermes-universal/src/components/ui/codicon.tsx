import type * as React from 'react'

import { cn } from '@/lib/utils'

// VS Code codicons (@vscode/codicons) — the same icon pack hermes-desktop uses
// for its window chrome, so the titlebar/controls match desktop exactly. Font
// loaded via `import '@vscode/codicons/dist/codicon.css'` in main.tsx.
export interface CodiconProps extends React.HTMLAttributes<HTMLElement> {
  name: string
  size?: number | string
  spinning?: boolean
}

export function Codicon({ className, name, size, spinning, style, ...props }: CodiconProps) {
  return (
    <i
      aria-hidden="true"
      className={cn('codicon', `codicon-${name}`, spinning && 'codicon-modifier-spin', className)}
      style={{ fontSize: size, ...style }}
      {...props}
    />
  )
}
