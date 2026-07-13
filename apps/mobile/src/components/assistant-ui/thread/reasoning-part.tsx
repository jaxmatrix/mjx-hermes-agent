import type { ReasoningMessagePartProps } from '@assistant-ui/react'
import { useState } from 'react'

// Collapsible "Thinking…" disclosure for a reasoning part (G6).
export function ReasoningPart({ text }: ReasoningMessagePartProps) {
  const [open, setOpen] = useState(false)
  if (!text) return null
  return (
    <div className="reasoning">
      <button className="reasoning-toggle" onClick={() => setOpen(o => !o)} type="button">
        {open ? 'Hide reasoning' : 'Show reasoning'}
      </button>
      {open && <div className="reasoning-body">{text}</div>}
    </div>
  )
}
