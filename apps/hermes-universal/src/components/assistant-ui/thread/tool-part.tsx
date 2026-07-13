import type { ToolCallMessagePartProps } from '@assistant-ui/react'
import { useState } from 'react'

import { summarizeShellCommand } from '@/lib/summarize-command'
import { prettyName } from '@/lib/text'
import { extractToolErrorMessage, formatToolResultSummary } from '@/lib/tool-result-summary'
import { cn } from '@/lib/utils'

// Lean tool-call row (Gc4): humanized title + status + a collapsible body with a
// formatted result (or error) via the ported formatters. This adapts the desktop
// tool view without its i18n title dictionary / tone machinery.
// FIXME(G4): richer parity (inline file diffs, ansi terminal colors, search-hit
// grouping, image results) from the desktop fallback-model/buildToolView.

function toolTitle(toolName: string, args: Record<string, unknown> | undefined): string {
  const command = args?.command ?? args?.cmd ?? args?.code
  if (typeof command === 'string' && command.trim()) return summarizeShellCommand(command)
  const path = args?.path ?? args?.file_path ?? args?.file
  if (typeof path === 'string' && path.trim()) return `${prettyName(toolName)}: ${path}`
  const query = args?.query ?? args?.pattern
  if (typeof query === 'string' && query.trim()) return `${prettyName(toolName)}: ${query}`
  return prettyName(toolName)
}

export function ToolPart({ toolName, args, result, isError }: ToolCallMessagePartProps) {
  const [open, setOpen] = useState(false)
  const running = result === undefined && !isError
  const argsObj = args as Record<string, unknown> | undefined

  const title = toolTitle(toolName, argsObj)
  const body = isError ? extractToolErrorMessage(result) : result !== undefined ? formatToolResultSummary(result) : ''
  const argsText = argsObj && Object.keys(argsObj).length > 0 ? JSON.stringify(argsObj, null, 2) : ''
  const hasDetail = Boolean(body || argsText)

  return (
    <div className="my-1 overflow-hidden rounded-md border border-border bg-muted/40 text-sm">
      <button
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
        onClick={() => hasDetail && setOpen(o => !o)}
        style={{ cursor: hasDetail ? 'pointer' : 'default' }}
        type="button"
      >
        <span
          className={cn(
            'size-2 shrink-0 rounded-full',
            running ? 'animate-pulse bg-primary' : isError ? 'bg-destructive' : 'bg-[var(--ui-good)]'
          )}
        />
        <span className="min-w-0 flex-1 truncate font-medium text-foreground">{title}</span>
        {hasDetail && <span className="text-muted-foreground">{open ? '−' : '+'}</span>}
      </button>
      {open && hasDetail && (
        <div className="border-t border-border px-3 py-2">
          {body && (
            <pre
              className={cn(
                'overflow-x-auto break-words whitespace-pre-wrap text-xs',
                isError ? 'text-destructive' : 'text-muted-foreground'
              )}
            >
              {body}
            </pre>
          )}
          {argsText && (
            <details className="mt-1">
              <summary className="cursor-pointer text-xs text-muted-foreground">args</summary>
              <pre className="mt-1 overflow-x-auto break-words whitespace-pre-wrap text-xs text-muted-foreground">
                {argsText}
              </pre>
            </details>
          )}
        </div>
      )}
    </div>
  )
}
