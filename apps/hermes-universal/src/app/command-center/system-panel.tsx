import { useEffect, useState } from 'react'

import { ListRow, LoadingState, SettingsContent } from '@/app/settings/primitives'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { getLogs, getStatus, restartGateway, updateHermes } from '@/hermes'
import { useI18n } from '@/i18n'
import { runAction } from '@/lib/action-poll'
import { notify } from '@/store/notifications'
import type { StatusResponse } from '@/types/hermes'

export function SystemPanel() {
  const { t } = useI18n()
  const cc = t.commandCenter
  const [status, setStatus] = useState<StatusResponse | null>(null)
  const [logs, setLogs] = useState<string[]>([])
  const [busy, setBusy] = useState<null | 'restart' | 'update'>(null)
  const [confirm, setConfirm] = useState<null | 'restart' | 'update'>(null)

  const refresh = async () => {
    try {
      const [s, l] = await Promise.all([getStatus(), getLogs({ file: 'gateway', lines: 40 }).catch(() => ({ lines: [] as string[] }))])
      setStatus(s)
      setLogs(l.lines)
    } catch {
      /* status card just stays empty */
    }
  }

  useEffect(() => void refresh(), [])

  const runOp = async (kind: 'restart' | 'update') => {
    setConfirm(null)
    setBusy(kind)
    try {
      const { ok } = await runAction(() => (kind === 'restart' ? restartGateway() : updateHermes()))
      notify({ kind: ok ? 'success' : 'warning', message: ok ? cc.actionDone : cc.gatewayRestartFailed })
      await refresh()
    } finally {
      setBusy(null)
    }
  }

  if (!status) {
    return <LoadingState label={cc.loadingStatus} />
  }

  return (
    <SettingsContent>
      <div className="mt-3 rounded-lg border border-border bg-card p-3">
        <div className="text-sm font-medium text-foreground">{cc.hermesActiveSessions(status.version, status.active_sessions)}</div>
        <div className="mt-1 text-xs text-muted-foreground">{status.gateway_running ? cc.gatewayRunning : cc.gatewayStopped}</div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <Button disabled={busy !== null} onClick={() => setConfirm('restart')} variant="outline">
          {busy === 'restart' ? cc.refreshing : cc.restartGateway}
        </Button>
        <Button disabled={busy !== null} onClick={() => setConfirm('update')} variant="outline">
          {busy === 'update' ? cc.refreshing : cc.updateHermes}
        </Button>
      </div>

      <div className="mt-5">
        <ListRow title={cc.recentLogs} />
        {logs.length === 0 ? (
          <p className="py-4 text-center text-xs text-muted-foreground">{cc.noLogs}</p>
        ) : (
          <pre className="mt-1 max-h-72 overflow-auto rounded-lg bg-muted p-3 font-mono text-[0.7rem] whitespace-pre-wrap text-muted-foreground">
            {logs.join('\n')}
          </pre>
        )}
      </div>

      <Dialog onOpenChange={open => !open && setConfirm(null)} open={confirm !== null}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{confirm === 'update' ? cc.updateHermes : cc.restartGateway}</DialogTitle>
            <DialogDescription>{cc.actionStartedWaiting}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost">{t.common.cancel}</Button>
            </DialogClose>
            <Button onClick={() => confirm && void runOp(confirm)}>{t.common.confirm}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsContent>
  )
}
