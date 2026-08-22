'use client'

import { type ToolCallMessagePartProps, useAuiState } from '@assistant-ui/react'
import { useStore } from '@nanostores/react'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useSessionView } from '@/app/chat/session-view'
import { ToolFallback } from '@/components/assistant-ui/tool/fallback'
import { WIDGET_SHELL_CLASS } from '@/components/chat/widget-shell'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { Input } from '@/components/ui/input'
import {
  authMcpServer,
  cancelMcpOAuthFlow,
  getActionStatus,
  getMcpCatalog,
  getMcpOAuthFlow,
  installMcpCatalogEntry,
  setMcpServerEnabled
} from '@/hermes'
import { useI18n } from '@/i18n'
import { openExternalLink } from '@/lib/external-link'
import { respondMcpSetup } from '@/lib/gateway-rpc'
import { triggerHaptic } from '@/lib/haptics'
import { AlertCircle, CheckCircle2, Loader2 } from '@/lib/icons'
import { brandFor, brandGlyphStyle } from '@/lib/mcp-brands'
import { completeMcpDesktopOAuth, McpOAuthCancelled } from '@/lib/mcp-dashboard-oauth'
import { directoryEntry } from '@/lib/mcp-directory'
import { removeMcpServerEntry, writeMcpServerEntry } from '@/lib/mcp-servers'
import { prettyName } from '@/lib/text'
import { cn } from '@/lib/utils'
import { requestGateway } from '@/store/gateway'
import { type McpSetupClientOutcome, type McpSetupStatus, readMcpSetupAction } from '@/store/mcp-setup'
import { notifyError } from '@/store/notifications'
import { clearSessionMcpSetup, type McpSetupAction, sessionMcpSetupRequest } from '@/store/prompts'
import { invalidateMcpSuggestionIndex } from '@/store/suggestion-providers/mcp'
import type { McpCatalogEntry } from '@/types/hermes'

import { selectMessageRunning } from './tool/fallback-model'
import { parseMaybeObject } from './tool/fallback-model/format'

// Ported from apps/desktop/src/components/assistant-ui/mcp-setup-tool.tsx.
//
// The inline consent card for the agent's `setup_mcp` tool: it proposes an MCP
// server, the user installs / enables / authorizes it right here, and the tool
// unblocks with the outcome. Like the clarify card this is the ONLY interactive
// surface for its request — there is no bar, no dialog.
//
// The identity rule (and the reason this card reads the STORE, not its own tool
// args): the answer must carry the `request_id` of the card that raised it. Args
// arrive with `tool.complete`, long after the request; the prompt store entry —
// written by `store/event-router.ts` from `mcp.setup.request` — is the only
// thing that has the id while the card is live, and it is read per SESSION KEY
// so a tile's card answers the tile's agent.
//
// Divergence from desktop, deliberate: universal has no `addMcpServer` /
// `removeMcpServer` REST pair, so the URL-only install writes through
// `lib/mcp-servers.ts`'s merge-over-fresh helpers — the same path the
// `hermes://mcp/install` dialog uses (MJXHRM-454), not a second one.

interface SetupArgs {
  action: McpSetupAction
  reason: string
  server: string
}

const CATALOG_INSTALL_POLL_MS = 1500

// Thrown by the in-flight flow when the user cancels — the declined respond has
// already been sent by `decline`, so the catch path swallows this rather than
// reporting it or answering a second time.
const CANCELLED = Symbol('mcp-setup-cancelled')

function readSetupArgs(args: unknown): SetupArgs {
  const row = parseMaybeObject(args)

  return {
    action: readMcpSetupAction(row.action),
    reason: typeof row.reason === 'string' ? row.reason : '',
    server: typeof row.server === 'string' ? row.server.trim() : ''
  }
}

/** The tool's settled JSON — this card's outcome plus the tool-only
 *  `unanswered` status, which only a 600s timeout produces. */
interface SettledResult {
  detail?: string
  note?: string
  server?: string
  status?: 'unanswered' | McpSetupStatus
  tools?: unknown
}

function readSetupResult(result: unknown): SettledResult {
  return parseMaybeObject(result) as SettledResult
}

const SHELL_CLASS = `${WIDGET_SHELL_CLASS} text-[length:var(--conversation-text-font-size)] text-(--ui-text-primary)`

// Same platform sniff the approval bar uses for its accelerator hint.
const isMac = typeof navigator !== 'undefined' && /Mac|iP(hone|ad|od)/.test(navigator.platform)

const ICON_CLASS = 'mt-px size-4 shrink-0 text-(--ui-text-tertiary)'

function SetupLine({ children, trailing }: { children: ReactNode; trailing?: ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      <div className="min-w-0 flex-1">{children}</div>
      {trailing}
    </div>
  )
}

export const McpSetupTool = (props: ToolCallMessagePartProps) => {
  // Settled → static outcome line (the flow already ran, or was declined).
  if (props.result !== undefined) {
    return <McpSetupSettled {...props} />
  }

  return <McpSetupLive {...props} />
}

const McpSetupLive = (props: ToolCallMessagePartProps) => {
  const messageRunning = useAuiState(selectMessageRunning)

  // Stopped mid-prompt with no result — don't leave a dead interactive panel
  // whose buttons would run a real install against a tool that already returned.
  if (!messageRunning) {
    return <ToolFallback {...props} />
  }

  return <McpSetupPending {...props} />
}

function McpSetupSettled({ args, result }: ToolCallMessagePartProps) {
  const { t } = useI18n()
  const copy = t.assistant.mcpSetup
  const fromArgs = useMemo(() => readSetupArgs(args), [args])
  const fromResult = useMemo(() => readSetupResult(result), [result])

  const server = fromResult.server || fromArgs.server
  const status = fromResult.status ?? 'error'
  const displayName = prettyName(server)

  const line =
    status === 'installed'
      ? copy.installed(displayName)
      : status === 'enabled'
        ? copy.enabled(displayName)
        : status === 'authorized'
          ? copy.authorized(displayName)
          : status === 'declined'
            ? copy.declined
            : status === 'unanswered'
              ? copy.unanswered
              : copy.failed(displayName)

  const ok = status === 'installed' || status === 'enabled' || status === 'authorized'
  const neutral = status === 'declined' || status === 'unanswered'
  const toolCount = Array.isArray(fromResult.tools) ? fromResult.tools.length : 0
  const brand = brandFor(server)

  return (
    <div className={cn(SHELL_CLASS, 'my-1.5 grid gap-1.5')} data-slot="mcp-setup-inline">
      <SetupLine
        trailing={
          ok ? (
            <CheckCircle2 aria-hidden className={cn(ICON_CLASS, 'text-emerald-400')} />
          ) : neutral && brand ? (
            <brand.Icon aria-hidden className="mt-px size-4 shrink-0 opacity-60" style={brandGlyphStyle(brand)} />
          ) : neutral ? (
            <Codicon className={ICON_CLASS} name="plug" size="1rem" />
          ) : (
            <AlertCircle aria-hidden className={cn(ICON_CLASS, 'text-destructive')} />
          )
        }
      >
        <span className={cn('font-medium', neutral && 'text-(--ui-text-tertiary) italic')}>{line}</span>
        {ok && toolCount > 0 && <span className="ms-2 text-(--ui-text-tertiary)">{copy.toolCount(toolCount)}</span>}
        {!ok && !neutral && fromResult.detail ? (
          <p className="mt-0.5 text-(--ui-text-secondary)">{fromResult.detail}</p>
        ) : null}
      </SetupLine>
    </div>
  )
}

function McpSetupPending({ args }: ToolCallMessagePartProps) {
  const { t } = useI18n()
  const copy = t.assistant.mcpSetup
  // The tool row is in whichever session's transcript rendered it — read THAT
  // session's request (primary or tile), not the globally-active one.
  const sessionKey = useStore(useSessionView().$runtimeId) ?? ''
  const $request = useMemo(() => sessionMcpSetupRequest(sessionKey), [sessionKey])
  const request = useStore($request)
  const fromArgs = useMemo(() => readSetupArgs(args), [args])

  const server = fromArgs.server || request?.server || ''
  const action: McpSetupAction = request?.action ?? fromArgs.action
  const reason = request?.reason || fromArgs.reason

  const [working, setWorking] = useState(false)
  const [envDraft, setEnvDraft] = useState<Record<string, string>>({})
  const [entry, setEntry] = useState<McpCatalogEntry | null | undefined>(undefined)
  const [envOpen, setEnvOpen] = useState(false)
  // Set when the user cancels mid-flight (a stuck OAuth tab, a hung install).
  // The in-flight flow checks it at every poll boundary and aborts via the
  // CANCELLED sentinel; the declined respond has already been sent by then.
  const cancelRef = useRef(false)

  // Race: `tool.start` fires a tick before `mcp.setup.request` — hold the
  // buttons until the request is wired (same spinner rule as clarify). Without
  // it an eager click would have no `request_id` to answer with.
  const ready = Boolean(request?.requestId)

  const respond = useCallback(
    async (outcome: McpSetupClientOutcome) => {
      // Another path (cancel racing completion) may already have resolved this
      // request; the store is the single source of truth, so bail if this
      // session's entry is gone or has moved on — answering a `request_id` twice
      // is an install the user consented to once, run twice.
      if (!request || sessionMcpSetupRequest(sessionKey).get()?.requestId !== request.requestId) {
        return
      }

      // Clear first: the answer is decided, and an in-flight RPC must not leave
      // a live card that can be answered a second time.
      clearSessionMcpSetup(sessionKey)

      // A successful outcome changed mcp_servers — reload the live session
      // BEFORE unblocking the tool, or the agent resumes being told the server
      // is ready while its tool snapshot still lacks it (the same write-through
      // the Capabilities tab's silentReload does; consent was the card click, so
      // no confirm prompt). Reload failure is not outcome failure: the config
      // landed and the tools arrive next session — report it and move on.
      if (outcome.status === 'installed' || outcome.status === 'enabled' || outcome.status === 'authorized') {
        try {
          await requestGateway('reload.mcp', { confirm: true, session_id: sessionKey || undefined })
        } catch (error) {
          notifyError(error, copy.reloadFailed)
        }

        // The just-set-up server must stop being offered as a composer pill.
        invalidateMcpSuggestionIndex()
      }

      try {
        await respondMcpSetup(request.requestId, outcome)
        // tool.complete lands next → McpSetupSettled.
      } catch (error) {
        notifyError(error, copy.sendFailed)
      }
    },
    [copy.reloadFailed, copy.sendFailed, request, sessionKey]
  )

  const decline = useCallback(() => {
    // While a flow is in flight this is a CANCEL: answer declined right away and
    // let the abandoned work notice via cancelRef at its next poll boundary.
    cancelRef.current = true
    void triggerHaptic('cancel')
    void respond({ server, status: 'declined' })
  }, [respond, server])

  const approve = useCallback(async () => {
    cancelRef.current = false
    setWorking(true)

    // Poll-boundary abort for the background-install loop; the OAuth flows carry
    // their own cancel via completeMcpDesktopOAuth's `cancelled`.
    const throwIfCancelled = <T,>(value: T): T => {
      if (cancelRef.current) {
        throw CANCELLED
      }

      return value
    }

    const runOAuth = (name: string) =>
      completeMcpDesktopOAuth({
        cancel: cancelMcpOAuthFlow,
        cancelled: () => cancelRef.current,
        openExternal: openExternalLink,
        serverName: name,
        start: authMcpServer,
        status: getMcpOAuthFlow
      })

    try {
      if (action === 'enable') {
        await setMcpServerEnabled(server, true)
        void triggerHaptic('submit')
        await respond({ server, status: 'enabled' })

        return
      }

      if (action === 'authorize') {
        const flow = await runOAuth(server)

        void triggerHaptic('submit')
        await respond({ server, status: 'authorized', tools: (flow.tools ?? []).map(tool => tool.name) })

        return
      }

      // Install: prefer the reviewed catalog entry when one exists; otherwise
      // fall back to the hosted-remote directory (official URL-only endpoints),
      // written through the same merge-over-fresh save the deep-link dialog
      // uses. Required catalog credentials get an inline prompt first (never
      // pre-filled, never echoed back).
      let resolved = entry

      if (resolved === undefined) {
        const catalog = await getMcpCatalog()

        resolved = catalog.entries.find(candidate => candidate.name === server) ?? null
        setEntry(resolved)
      }

      if (!resolved) {
        const known = directoryEntry(server)

        if (!known) {
          await respond({ detail: copy.notInCatalog(server), server, status: 'error' })

          return
        }

        // URL-only remote: add to config, then run the OAuth/probe flow so
        // "Install" lands the user on a working server, not a 401. If the flow
        // dies after the config write (cancel, closed OAuth tab), roll the write
        // back — decline means "no server", not an unauthorized entry squatting
        // in mcp_servers.
        await writeMcpServerEntry(known.name, { transport: 'http', url: known.url })

        let flow

        try {
          flow = await runOAuth(known.name)
        } catch (error) {
          await removeMcpServerEntry(known.name).catch(() => {
            // Rollback is best-effort; the primary error/cancel wins.
          })

          throw error
        }

        void triggerHaptic('submit')
        await respond({ server, status: 'installed', tools: (flow.tools ?? []).map(tool => tool.name) })

        return
      }

      const required = resolved.required_env.filter(env => env.required)

      if (required.some(env => !envDraft[env.name]?.trim())) {
        // Reveal the credential fields; the user approves again once filled.
        setEnvOpen(true)

        return
      }

      const res = await installMcpCatalogEntry(server, envDraft)

      // Git-backed entries clone in the background — poll to completion so a
      // non-zero exit surfaces as a real failure instead of a false success.
      if (res.background && res.action) {
        for (;;) {
          const status = throwIfCancelled(await getActionStatus(res.action, 1))

          if (!status.running) {
            if (status.exit_code !== 0) {
              // prettyName, like every other place this server is named — the
              // detail lands beside a heading that already reads "Linear".
              throw new Error(copy.failed(prettyName(server)))
            }

            break
          }

          await new Promise(resolve => setTimeout(resolve, CATALOG_INSTALL_POLL_MS))
        }
      }

      void triggerHaptic('submit')
      await respond({ server, status: 'installed' })
    } catch (error) {
      // User cancel: the declined respond is already on the wire — the abandoned
      // flow just stops, and answering again would hit a resolved request.
      if (error === CANCELLED || error instanceof McpOAuthCancelled) {
        return
      }

      notifyError(error, copy.failed(server))
      await respond({ detail: error instanceof Error ? error.message : String(error), server, status: 'error' })
    } finally {
      setWorking(false)
    }
  }, [action, copy, entry, envDraft, respond, server])

  const displayName = prettyName(server)

  const title =
    action === 'enable'
      ? copy.enableTitle(displayName)
      : action === 'authorize'
        ? copy.authorizeTitle(displayName)
        : copy.installTitle(displayName)

  const actionLabel =
    action === 'enable' ? copy.enableAction : action === 'authorize' ? copy.authorizeAction : copy.installAction

  // What connecting actually MEANS — the endpoint that will be contacted. VS
  // Code's trust dialog links the config it is about to trust; same idea, and
  // it is the whole capability disclosure this card carries.
  const known = directoryEntry(server)
  const sourceLine = action === 'install' ? (entry?.url ?? known?.url ?? copy.catalogSource) : null
  const brand = brandFor(server)

  const trailingIcon = brand ? (
    <brand.Icon aria-hidden className="mt-px size-4 shrink-0" style={brandGlyphStyle(brand)} />
  ) : (
    <Codicon className={ICON_CLASS} name="plug" size="1rem" />
  )

  // ⌘/Ctrl+Enter → approve, Esc → decline/cancel. Same accelerators and guard
  // shape as the approval bar. Unlike approve, Esc stays live while a flow is in
  // flight — that IS the cancel path, and a stuck OAuth tab must always have a
  // way out. Stands down whenever a focusable control has focus (clarify's
  // rule): a keystroke meant for the composer, a popover, or this card's own
  // credential fields must never silently approve an install.
  useEffect(() => {
    if (!ready) {
      return
    }

    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented) {
        return
      }

      const active = document.activeElement as HTMLElement | null

      if (
        active &&
        (active.isContentEditable || active.matches('a[href], button, input, select, textarea, [role="button"]'))
      ) {
        return
      }

      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        if (!working) {
          event.preventDefault()
          void approve()
        }
      } else if (event.key === 'Escape') {
        event.preventDefault()
        decline()
      }
    }

    window.addEventListener('keydown', onKeyDown, true)

    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [approve, decline, ready, working])

  if (!ready) {
    return (
      <div className={cn(SHELL_CLASS, 'my-1.5 flex items-center gap-2')} data-slot="mcp-setup-inline">
        <Loader2 aria-hidden className="size-4 animate-spin text-(--ui-text-tertiary)" />
        <span className="text-(--ui-text-tertiary)">{title}</span>
      </div>
    )
  }

  return (
    <div className={cn(SHELL_CLASS, 'my-1.5 grid gap-1.5')} data-slot="mcp-setup-inline">
      <SetupLine trailing={trailingIcon}>
        <span className="leading-(--conversation-line-height) font-medium">{title}</span>
        {reason ? <p className="mt-0.5 text-(--ui-text-secondary)">{reason}</p> : null}
        {sourceLine && <p className="mt-0.5 truncate text-[0.6875rem] text-(--ui-text-tertiary)">{sourceLine}</p>}
      </SetupLine>
      {envOpen && entry && entry.required_env.length > 0 && (
        <div className="grid gap-2" data-slot="mcp-setup-env">
          <p className="text-[0.6875rem] text-(--ui-text-tertiary)">{copy.envRequired}</p>
          {entry.required_env.map(env => (
            <label className="grid gap-1" key={env.name}>
              <span className="text-[0.6875rem] text-(--ui-text-secondary)">
                {env.prompt || env.name}
                {env.required ? ' *' : ''}
              </span>
              <Input
                className="h-7 text-xs"
                onChange={event => {
                  // Read the value BEFORE the updater runs: React clears
                  // `currentTarget` once the handler returns, and the state
                  // updater is a deferred closure — reading it in there throws
                  // on the first keystroke and takes the whole card down.
                  const { value } = event.target

                  setEnvDraft(prev => ({ ...prev, [env.name]: value }))
                }}
                type="password"
                value={envDraft[env.name] ?? ''}
              />
            </label>
          ))}
        </div>
      )}
      {/* Same strip as the tool approval bar: a bordered primary-tinted action
          plus a quiet ghost decline, with the matching keyboard hints. One
          consent vocabulary across the transcript. */}
      <div className="flex items-center gap-2.5">
        <div className="inline-flex h-6 items-stretch overflow-hidden rounded-md border border-primary/25 bg-primary/10 text-primary">
          <Button
            className="h-full gap-1 rounded-none px-2 text-xs font-medium text-primary hover:bg-primary/15 hover:text-primary"
            disabled={working}
            onClick={() => void approve()}
            size="xs"
            variant="ghost"
          >
            {working ? <Loader2 className="size-3 animate-spin" /> : actionLabel}
            {!working && <span className="text-[0.625rem] text-primary/60">{isMac ? '⌘⏎' : 'Ctrl⏎'}</span>}
          </Button>
        </div>
        {/* Never disabled: while a flow is in flight this is the cancel — a
            stuck OAuth tab or hung install must always have a way out. */}
        <Button
          className="h-6 gap-1.5 rounded-md px-1.5 text-xs font-normal text-(--ui-text-tertiary) hover:text-foreground"
          onClick={decline}
          size="xs"
          variant="ghost"
        >
          {working ? t.common.cancel : copy.decline}
          <span className="text-[0.625rem] opacity-55">Esc</span>
        </Button>
      </div>
    </div>
  )
}
