import '@xterm/xterm/css/xterm.css'

import { Button } from '@/components/ui/button'
import { KbdCombo } from '@/components/ui/kbd'
import { Loader } from '@/components/ui/loader'
import { type Translations, useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import type { TerminalEnd, TerminalTransportKind } from '@/transport/terminal-transport'

import { reportTerminalShell } from './terminals'
import { useAgentTerminal } from './use-agent-terminal'
import { useTerminalSession } from './use-terminal-session'

// Absolute-stacked so inactive tabs keep layout size (a display:none host goes
// 0×0 and renders garbled on re-show); visibility toggles which one is seen.
const INSTANCE_CLASS = 'absolute inset-0 flex flex-col bg-(--ui-terminal-surface-background) px-2 pb-2 pt-0'

// xterm host. The screen/viewport overrides matter for the DOM renderer (the
// WebGL fast-path paints the canvas from ITheme.background instead) — both
// resolve to the same token, so the two renderers can't disagree.
const HOST_CLASS =
  'h-full min-h-0 overflow-hidden text-(--ui-text-secondary) [&_.xterm]:h-full [&_.xterm-screen]:bg-(--ui-terminal-surface-background)! [&_.xterm-viewport]:bg-(--ui-terminal-surface-background)!'

interface TerminalInstanceProps {
  id: string
  cwd: string
  active: boolean
  onAddSelectionToChat: (text: string, label?: string) => void
  restoreCwd?: string
  reviveBuffer?: string
}

/** The end state, as a sentence. Mirrors TerminalView — every transport failure
 *  lands here so the tile never goes blank. */
function endCopy(
  t: Translations,
  end: TerminalEnd,
  kind: TerminalTransportKind
): { body: string; title: string } {
  const copy = t.rightSidebar

  switch (end.kind) {
    case 'auth':
      return { body: copy.terminalEndAuthBody, title: copy.terminalEndAuthTitle }

    case 'disabled':
      return { body: copy.terminalEndDisabledBody, title: copy.terminalEndDisabledTitle }

    case 'error':
      return { body: copy.terminalEndErrorBody, title: copy.terminalEndErrorTitle }

    case 'refused':
      return { body: copy.terminalEndRefusedBody, title: copy.terminalEndRefusedTitle }

    case 'superseded':
      return { body: copy.terminalEndSupersededBody, title: copy.terminalEndSupersededTitle }

    case 'unsupported':
      return kind === 'remote'
        ? { body: copy.terminalEndNoGatewayShellBody, title: copy.terminalEndNoGatewayShellTitle }
        : { body: copy.terminalEndNoLocalShellBody, title: copy.terminalEndNoLocalShellTitle }

    case 'exited':

    default:
      return { body: copy.terminalEndExitedBody, title: copy.terminalEndExitedTitle }
  }
}

/** One persistent xterm+PTY. Every open tab stays mounted (so its shell and
 *  scrollback survive tab switches); only the active one is shown. */
export function TerminalInstance({
  id,
  active,
  cwd,
  onAddSelectionToChat,
  restoreCwd,
  reviveBuffer
}: TerminalInstanceProps) {
  const { t } = useI18n()

  const {
    addSelectionToChat,
    end,
    fellBack,
    hostRef,
    restart,
    selection,
    selectionStyle,
    status,
    transportKind
  } = useTerminalSession({
    id,
    cwd,
    active,
    onAddSelectionToChat,
    restoreCwd,
    reviveBuffer,
    onShell: shell => reportTerminalShell(id, shell)
  })

  const copy = end && status === 'closed' ? endCopy(t, end, transportKind) : null

  return (
    <div
      className={cn(INSTANCE_CLASS, active ? 'visible' : 'invisible pointer-events-none')}
      // Focus-scope marker so isFocusWithin('[data-terminal]') can route ⌘W here.
      data-terminal=""
    >
      {status === 'starting' && (
        <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center">
          <Loader
            className="size-8 text-(--ui-text-tertiary)"
            pathSteps={180}
            strokeScale={0.68}
            type="spiral-search"
          />
        </div>
      )}
      {fellBack && status === 'open' && (
        <div
          // eslint-disable-next-line better-tailwindcss/no-restricted-classes -- over a surface pinned left-to-right — see the [dir='rtl'] block in styles.css
          className="pointer-events-none absolute right-2 top-1 z-20 max-w-[70%] truncate rounded bg-destructive/40 px-1.5 py-0.5 text-[0.65rem] text-white/90"
          title={t.rightSidebar.terminalLocalFallbackChip}
        >
          ⚠ {t.rightSidebar.terminalLocalFallbackChip}
        </div>
      )}
      {selection.trim() && (
        <div className="absolute z-50 flex items-center gap-1" style={selectionStyle ?? { right: 12, top: 8 }}>
          <Button
            className="h-6 rounded-md px-2 text-[0.68rem] shadow-md backdrop-blur-md"
            onClick={event => event.preventDefault()}
            onMouseDown={event => {
              event.preventDefault()
              event.stopPropagation()
              addSelectionToChat()
            }}
            type="button"
            variant="secondary"
          >
            {t.rightSidebar.addToChat}
            <KbdCombo className="ms-1 opacity-70" combo="mod+l" size="sm" />
          </Button>
        </div>
      )}
      {/* Outer div paints the terminal inset; inner div is the xterm host so the
          canvas sizes to the content area and p-2 stays as terminal padding. */}
      <div className={HOST_CLASS} ref={hostRef} />
      {copy && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-(--ui-terminal-surface-background)/85 p-6">
          <div className="flex max-w-xs flex-col items-center gap-2 text-center">
            <div
              className={cn('text-sm font-medium', end?.kind === 'exited' ? 'text-foreground' : 'text-destructive')}
            >
              {copy.title}
            </div>
            <p className="text-xs text-muted-foreground">{copy.body}</p>
            {end?.detail && (
              <p className="max-h-16 overflow-y-auto font-code text-[0.65rem] break-words text-muted-foreground/80">
                {end.detail}
              </p>
            )}
            <Button className="mt-1" onClick={restart} size="sm" variant="secondary">
              {t.rightSidebar.terminalRestart}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

interface AgentTerminalInstanceProps {
  active: boolean
  id: string
  procId: string
}

/** Read-only mirror of an agent background process — a write-only xterm streamed
 *  live from the backend output (no PTY, no input). */
export function AgentTerminalInstance({ active, id, procId }: AgentTerminalInstanceProps) {
  const { hostRef } = useAgentTerminal({ active, id, procId })

  return (
    <div
      className={cn(INSTANCE_CLASS, active ? 'visible' : 'invisible pointer-events-none')}
      // Same focus-scope marker as the user terminal so isFocusWithin('[data-terminal]')
      // routes ⌘W here and closes the focused agent tab (not a preview).
      data-terminal=""
    >
      <div className={HOST_CLASS} ref={hostRef} />
    </div>
  )
}
