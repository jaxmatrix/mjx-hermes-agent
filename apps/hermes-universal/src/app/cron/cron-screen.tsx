import { useEffect, useState } from 'react'

import { EmptyState, ListRow, LoadingState, SettingsContent } from '@/app/settings/primitives'
import { SidebarTrigger } from '@/app/shell/sidebar'
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Switch } from '@/components/ui/switch'
import { useI18n } from '@/i18n'
import { MoreVertical, Plus } from '@/lib/icons'
import { useStore } from '@/store/atom'
import { $cronJobs, $cronLoadError, $cronLoading, refreshCronJobs, removeCron, setCronEnabled, triggerCron } from '@/store/cron'
import { notify } from '@/store/notifications'
import type { CronJob } from '@/types/hermes'

import { CronForm } from './cron-form'
import { jobName, jobScheduleDisplay } from './schedule'

export function CronScreen() {
  const { t } = useI18n()
  const c = t.cron
  const jobs = useStore($cronJobs)
  const loading = useStore($cronLoading)
  const loadError = useStore($cronLoadError)
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<CronJob | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<CronJob | null>(null)

  useEffect(() => void refreshCronJobs(), [])

  const openCreate = () => {
    setEditing(null)
    setFormOpen(true)
  }
  const openEdit = (job: CronJob) => {
    setEditing(job)
    setFormOpen(true)
  }

  const stateLabel = (job: CronJob) => {
    const key = job.state as keyof typeof c.states
    return c.states[key] ?? (job.enabled ? c.states.enabled : c.states.disabled)
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b border-border p-3">
        <SidebarTrigger className="md:hidden" />
        <h1 className="min-w-0 flex-1 truncate text-base font-semibold text-foreground">{c.title}</h1>
        <Button aria-label={c.newCron} onClick={openCreate} size="icon-sm" variant="ghost">
          <Plus className="size-5" />
        </Button>
      </header>

      {loading && jobs.length === 0 ? (
        <LoadingState label={c.loading} />
      ) : loadError && jobs.length === 0 ? (
        <SettingsContent>
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <span className="text-sm text-muted-foreground">{c.failedLoad}</span>
            <Button onClick={() => void refreshCronJobs()} size="sm">
              {t.common.retry}
            </Button>
          </div>
        </SettingsContent>
      ) : jobs.length === 0 ? (
        <SettingsContent>
          <EmptyState description={c.emptyDescNew} title={c.emptyTitleNew} />
        </SettingsContent>
      ) : (
        <SettingsContent>
          <div className="pt-1">
            {jobs.map(job => (
              <ListRow
                key={job.id}
                description={`${jobScheduleDisplay(job)} · ${stateLabel(job)}`}
                title={<span className="truncate">{jobName(job) || job.prompt || job.id}</span>}
                action={
                  <div className="flex items-center gap-1">
                    <Switch checked={job.enabled} onCheckedChange={on => void setCronEnabled(job.id, on)} />
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button aria-label={c.actionsTitle} size="icon-sm" variant="ghost">
                          <MoreVertical className="size-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          onSelect={() => {
                            void triggerCron(job.id)
                            notify({ kind: 'success', message: c.triggered })
                          }}
                        >
                          {c.triggerNow}
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => openEdit(job)}>{c.edit}</DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => setConfirmDelete(job)} variant="destructive">
                          {c.deleteTitle}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                }
              />
            ))}
          </div>
        </SettingsContent>
      )}

      <CronForm job={editing} onOpenChange={setFormOpen} open={formOpen} />

      <Dialog onOpenChange={open => !open && setConfirmDelete(null)} open={confirmDelete !== null}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{c.deleteTitle}</DialogTitle>
            <DialogDescription>
              {c.deleteDescPrefix}
              <span className="font-medium">{confirmDelete ? jobName(confirmDelete) || confirmDelete.id : ''}</span>
              {c.deleteDescSuffix}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost">{t.common.cancel}</Button>
            </DialogClose>
            <Button
              onClick={() => {
                if (confirmDelete) {
                  void removeCron(confirmDelete.id)
                  notify({ kind: 'success', message: c.deleted })
                }
                setConfirmDelete(null)
              }}
              variant="destructive"
            >
              {c.deleteTitle}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
