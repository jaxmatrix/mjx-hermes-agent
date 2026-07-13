import type { ToolCallMessagePartProps } from '@assistant-ui/react'
import { useState } from 'react'

// Minimal tool-call row: name + running/done state + collapsible args/result.
// FIXME(G4): port the full buildToolView (inline diffs, ansi, search hits,
// image, file-edit summaries) from apps/desktop tool/fallback-model.
export function ToolPart({ toolName, args, result, isError }: ToolCallMessagePartProps) {
  const [open, setOpen] = useState(false)
  const running = result === undefined && !isError
  const hasDetail = (args && Object.keys(args).length > 0) || result !== undefined

  return (
    <div className="tools">
      <button
        className={`tool-chip ${running ? 'tool-running' : isError ? '' : 'tool-done'}`}
        onClick={() => hasDetail && setOpen(o => !o)}
        style={{ border: 'none', cursor: hasDetail ? 'pointer' : 'default' }}
        type="button"
      >
        {toolName}
        {running && <span className="tool-dot" />}
      </button>
      {open && hasDetail && (
        <pre className="reasoning-body" style={{ whiteSpace: 'pre-wrap', width: '100%' }}>
          {args ? `args: ${JSON.stringify(args, null, 2)}\n` : ''}
          {result !== undefined ? `result: ${typeof result === 'string' ? result : JSON.stringify(result, null, 2)}` : ''}
        </pre>
      )}
    </div>
  )
}
