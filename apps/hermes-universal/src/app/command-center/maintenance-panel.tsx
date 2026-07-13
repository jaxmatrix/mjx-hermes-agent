import { useEffect, useState } from 'react'

import { ListRow, SettingsContent } from '@/app/settings/primitives'
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
import { Switch } from '@/components/ui/switch'
import {
  getCuratorStatus,
  getMemoryStatus,
  resetMemory,
  runBackup,
  runCurator,
  runDoctor,
  runSecurityAudit,
  setCuratorPaused
} from '@/hermes'
import { useI18n } from '@/i18n'
import { runAction } from '@/lib/action-poll'
import { notify } from '@/store/notifications'
import type { CuratorStatusResponse, MemoryStatusResponse } from '@/types/hermes'

type Diagnostic = { label: string; desc: string; run: () => Promise<{ name: string }> }
type ResetTarget = 'all' | 'memory' | 'user'

export function MaintenancePanel() {
  const { t } = useI18n()
  const m = t.commandCenter.maintenance
  const [busy, setBusy] = useState<string | null>(null)
  const [curator, setCurator] = useState<CuratorStatusResponse | null>(null)
  const [memory, setMemory] = useState<MemoryStatusResponse | null>(null)
  const [reset, setReset] = useState<ResetTarget | null>(null)

  const refresh = async () => {
    const [c, mem] = await Promise.all([getCuratorStatus().catch(() => null), getMemoryStatus().catch(() => null)])
    setCurator(c)
    setMemory(mem)
  }
  useEffect(() => void refresh(), [])

  const runOp = async (label: string, spawn: () => Promise<{ name: string }>) => {
    setBusy(label)
    try {
      const { ok } = await runAction(spawn)
      notify({ kind: ok ? 'success' : 'warning', message: ok ? m.actionStarted(label) : m.actionFailed(label) })
      await refresh()
    } finally {
      setBusy(null)
    }
  }

  const diagnostics: Diagnostic[] = [
    { label: m.doctor, desc: m.doctorDesc, run: runDoctor },
    { label: m.securityAudit, desc: m.securityAuditDesc, run: runSecurityAudit },
    { label: m.backup, desc: m.backupDesc, run: runBackup }
  ]

  const curatorLabel = !curator?.enabled ? m.curatorDisabled : curator.paused ? m.curatorPaused : m.curatorActive

  const doReset = async (target: ResetTarget) => {
    setReset(null)
    try {
      const res = await resetMemory(target)
      notify({ kind: 'success', message: m.resetDone(res.deleted.join(', ') || '0') })
      await refresh()
    } catch {
      notify({ kind: 'warning', message: m.resetFailed })
    }
  }

  return (
    <SettingsContent>
      {/* Diagnostics */}
      <div className="mt-3">
        <ListRow title={m.runOps} />
        {diagnostics.map(d => (
          <ListRow
            key={d.label}
            description={d.desc}
            title={d.label}
            action={
              <Button disabled={busy !== null} onClick={() => void runOp(d.label, d.run)} size="sm" variant="outline">
                {busy === d.label ? m.running : d.label}
              </Button>
            }
          />
        ))}
        {/* FIXME(K4): debug-share deferred — needs a Tauri clipboard shim for its share links. */}
      </div>

      {/* Curator */}
      <div className="mt-5">
        <ListRow
          description={curator?.last_run_at ? m.curatorLastRun(curator.last_run_at) : m.curatorNeverRan}
          title={`${m.curator} · ${curatorLabel}`}
          action={
            <div className="flex items-center gap-2">
              <Button disabled={busy !== null} onClick={() => void runOp(m.curator, runCurator)} size="sm" variant="ghost">
                {m.runNow}
              </Button>
              <Switch
                aria-label={curator?.paused ? m.resume : m.pause}
                checked={!curator?.paused}
                disabled={!curator?.enabled}
                onCheckedChange={on => {
                  void setCuratorPaused(!on).then(refresh)
                }}
              />
            </div>
          }
        />
      </div>

      {/* Memory */}
      <div className="mt-5">
        <ListRow description={memory ? m.memoryProvider(memory.active) : m.memoryDataDesc} title={m.memoryData} />
        <div className="mt-2 grid grid-cols-3 gap-2">
          <Button onClick={() => setReset('memory')} size="sm" variant="ghost">
            {m.resetMemory}
          </Button>
          <Button onClick={() => setReset('user')} size="sm" variant="ghost">
            {m.resetUser}
          </Button>
          <Button onClick={() => setReset('all')} size="sm" variant="ghost">
            {m.resetAll}
          </Button>
        </div>
      </div>

      <Dialog onOpenChange={open => !open && setReset(null)} open={reset !== null}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{m.resetMemory}</DialogTitle>
            <DialogDescription>{reset ? m.resetConfirm(reset) : ''}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost">{t.common.cancel}</Button>
            </DialogClose>
            <Button onClick={() => reset && void doReset(reset)} variant="destructive">
              {m.resetMemory}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsContent>
  )
}
