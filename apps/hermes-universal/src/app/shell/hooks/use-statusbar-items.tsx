import { useMemo } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

import { useApprovalModeStatusbarItem } from '@/app/shell/approval-mode-menu'
import { ContextUsagePanel } from '@/app/shell/context-usage-panel'
import { GatewayMenuPanel } from '@/app/shell/gateway-menu-panel'
import type { StatusbarItem } from '@/app/shell/statusbar-controls'
import { Codicon } from '@/components/ui/codicon'
import { useI18n } from '@/i18n'
import { Activity, AlertCircle, Clock, Command, Hash, Loader2, Terminal } from '@/lib/icons'
import { IS_MOBILE } from '@/lib/platform'
import { contextBarLabel, LiveDuration, usageContextLabel } from '@/lib/statusbar'
import { cn } from '@/lib/utils'
import { AGENTS_ROUTE, appViewForPath, COMMAND_CENTER_ROUTE, CRON_ROUTE } from '@/app/routes'
import { useStore } from '@/store/atom'
import { $terminalOpen, toggleTerminalOpen } from '@/store/layout'
import { $busy, $currentUsage, $sessionId, $sessionStartedAt, $turnStartedAt } from '@/store/chat'
import { $connection, $status } from '@/store/connection'
import { $gatewayState, requestGateway } from '@/store/gateway'
import { $activeProfile } from '@/store/profiles'
import { activeSubagentCount, failedSubagentCount, $subagentsBySession } from '@/store/subagents'
import { $appVersion, $gatewayRestarting, $inferenceStatus, $statusSnapshot } from '@/store/system-status'

// Ported/adapted from apps/desktop/src/app/shell/hooks/use-statusbar-items.tsx.
// Assembles the left/right statusbar item descriptors from universal stores.
// Divergences from desktop, all driven by the remote-client shape:
//   • command-center / agents / cron navigate to routes (with an active
//     highlight from the current view) instead of toggling in-window panels;
//   • version items link to the Command Center system panel (no client
//     self-updater by design; the backend-update flow lives there);
//   • workspace-cwd + terminal are deferred (see the FIXME markers below);
//   • chrome-y items (command-center / cron / versions) hide on phones so the
//     touch bar stays a compact live-status strip.

export function useStatusbarItems(): {
  leftStatusbarItems: readonly StatusbarItem[]
  statusbarItems: readonly StatusbarItem[]
} {
  const { t } = useI18n()
  const copy = t.shell.statusbar
  const navigate = useNavigate()
  const view = appViewForPath(useLocation().pathname)

  const gatewayState = useStore($gatewayState)
  const statusSnapshot = useStore($statusSnapshot)
  const inferenceStatus = useStore($inferenceStatus)
  const gatewayRestarting = useStore($gatewayRestarting)
  const appVersion = useStore($appVersion)
  const connection = useStore($connection)
  const status = useStore($status)
  const activeProfile = useStore($activeProfile)
  const busy = useStore($busy)
  const turnStartedAt = useStore($turnStartedAt)
  const sessionStartedAt = useStore($sessionStartedAt)
  const currentUsage = useStore($currentUsage)
  const sessionId = useStore($sessionId)
  const subagentsBySession = useStore($subagentsBySession)
  const terminalOpen = useStore($terminalOpen)

  const contextUsage = usageContextLabel(currentUsage)
  const contextBar = contextBarLabel(currentUsage)
  const approvalModeItem = useApprovalModeStatusbarItem(activeProfile ?? '', requestGateway)

  const { subagentsFailed, subagentsRunning } = useMemo(() => {
    const lists = Object.values(subagentsBySession)

    return {
      subagentsFailed: lists.reduce((sum, items) => sum + failedSubagentCount(items), 0),
      subagentsRunning: lists.reduce((sum, items) => sum + activeSubagentCount(items), 0)
    }
  }, [subagentsBySession])

  // ---- gateway-health derivation (matches the desktop hook) ----
  const gatewayOpen = gatewayState === 'open'
  const gatewayConnecting = gatewayState === 'connecting'
  const inferenceReady = gatewayOpen && inferenceStatus?.ready === true
  const gatewayDegraded = gatewayOpen || gatewayConnecting

  const gatewayDetail = gatewayOpen
    ? inferenceStatus?.ready
      ? copy.gatewayReady
      : inferenceStatus
        ? copy.gatewayNeedsSetup
        : copy.gatewayChecking
    : gatewayConnecting
      ? copy.gatewayConnecting
      : copy.gatewayOffline

  const gatewayClassName = inferenceReady
    ? undefined
    : gatewayDegraded
      ? 'text-amber-600 hover:text-amber-600'
      : 'text-destructive hover:text-destructive'

  const gatewayMenuContent = (close: () => void) => (
    <GatewayMenuPanel
      gatewayState={gatewayState}
      inferenceStatus={inferenceStatus}
      onClose={close}
      onOpenSystem={() => navigate(COMMAND_CENTER_ROUTE)}
      statusSnapshot={statusSnapshot}
    />
  )

  const isRemoteBackend = connection?.mode === 'remote' || connection?.mode === 'cloud'
  const backendVersion = status?.version

  const leftStatusbarItems: StatusbarItem[] = [
    {
      className: cn('w-7 justify-center px-0', view === 'command-center' && 'bg-accent/55 text-foreground'),
      hidden: IS_MOBILE,
      icon: <Command className="size-3.5" />,
      id: 'command-center',
      title: copy.openCommandCenter,
      to: COMMAND_CENTER_ROUTE,
      variant: 'action'
    },
    {
      className: gatewayRestarting ? undefined : gatewayClassName,
      detail: gatewayRestarting ? copy.gatewayRestarting : gatewayDetail,
      icon: gatewayRestarting ? (
        <Codicon className="size-3 animate-spin" name="loading" size="0.75rem" />
      ) : inferenceReady ? (
        <Activity className="size-3" />
      ) : (
        <AlertCircle className="size-3" />
      ),
      id: 'gateway-health',
      label: copy.gateway,
      menuClassName: 'w-72',
      menuContent: gatewayMenuContent,
      title: inferenceStatus?.reason || copy.gatewayTitle,
      variant: 'menu'
    },
    // FIXME(statusbar-cwd): no per-session cwd atom on this client, and no
    // clipboard / file-manager-reveal / file-tree capability on the remote+mobile
    // target — so the desktop workspace-cwd item is deferred.
    {
      className: cn(
        view === 'agents' && 'bg-accent/55 text-foreground',
        subagentsFailed > 0 && 'text-destructive hover:text-destructive'
      ),
      detail:
        subagentsRunning > 0
          ? copy.subagents(subagentsRunning)
          : subagentsFailed > 0
            ? copy.failed(subagentsFailed)
            : undefined,
      icon:
        subagentsFailed > 0 ? (
          <AlertCircle className="size-3" />
        ) : subagentsRunning > 0 ? (
          <Loader2 className="size-3 animate-spin" />
        ) : (
          <Codicon name="hubot" size="0.75rem" />
        ),
      id: 'agents',
      label: copy.agents,
      title: copy.openAgents,
      to: AGENTS_ROUTE,
      variant: 'action'
    },
    {
      hidden: IS_MOBILE,
      icon: <Clock className="size-3" />,
      id: 'cron',
      label: copy.cron,
      title: copy.openCron,
      to: CRON_ROUTE,
      variant: 'action'
    }
  ]

  const statusbarItems: StatusbarItem[] = [
    {
      detail: <LiveDuration since={turnStartedAt} />,
      hidden: !busy || !turnStartedAt,
      icon: <Loader2 className="size-3 animate-spin" />,
      id: 'running-timer',
      label: copy.turnRunning,
      title: copy.currentTurnElapsed,
      variant: 'text'
    },
    {
      detail: contextBar || undefined,
      hidden: !contextUsage,
      id: 'context-usage',
      label: contextUsage,
      menuAlign: 'end',
      menuClassName: 'w-auto border-(--ui-stroke-secondary) p-0',
      menuContent: (
        <ContextUsagePanel currentUsage={currentUsage} requestGateway={requestGateway} sessionId={sessionId} />
      ),
      title: copy.openContextUsage,
      variant: 'menu'
    },
    {
      detail: <LiveDuration since={sessionStartedAt} />,
      hidden: !sessionStartedAt,
      id: 'session-timer',
      label: copy.session,
      title: copy.runtimeSessionElapsed,
      variant: 'text'
    },
    {
      ...approvalModeItem,
      hidden: gatewayState !== 'open'
    },
    {
      className: cn('w-7 justify-center px-0', terminalOpen && 'bg-accent/55 text-foreground'),
      icon: <Terminal className="size-3.5" />,
      id: 'terminal',
      onSelect: () => toggleTerminalOpen(),
      title: terminalOpen ? copy.hideTerminal : copy.showTerminal,
      variant: 'action'
    },
    {
      hidden: IS_MOBILE || !appVersion,
      icon: <Hash className="size-3" />,
      id: 'version-client',
      label: appVersion ? copy.clientLabel(appVersion) : copy.unknown,
      onSelect: () => navigate(COMMAND_CENTER_ROUTE),
      title: appVersion ? copy.clientLabel(appVersion) : undefined,
      variant: 'action'
    },
    {
      hidden: IS_MOBILE || !isRemoteBackend || !backendVersion,
      icon: <Hash className="size-3" />,
      id: 'version-backend',
      label: backendVersion ? copy.backendLabel(backendVersion) : copy.unknown,
      onSelect: () => navigate(COMMAND_CENTER_ROUTE),
      title: backendVersion ? copy.backendVersion(backendVersion) : undefined,
      variant: 'action'
    }
  ]

  return { leftStatusbarItems, statusbarItems }
}
