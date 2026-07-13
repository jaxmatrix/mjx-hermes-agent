import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Textarea } from '@/components/ui/textarea'
import { useI18n } from '@/i18n'
import { notify } from '@/store/notifications'
import { saveCron } from '@/store/cron'
import type { CronJob } from '@/types/hermes'

import {
  DEFAULT_DELIVER,
  DELIVERY_VALUES,
  type DeliveryTarget,
  exprForPreset,
  jobDeliver,
  jobName,
  jobScheduleExpr,
  presetForExpr,
  SCHEDULE_OPTIONS,
  type SchedulePreset
} from './schedule'

// Create/edit a cron job in a bottom sheet. Ported/leaned from desktop cron form.
export function CronForm({
  job,
  onOpenChange,
  open
}: {
  job: CronJob | null
  onOpenChange: (open: boolean) => void
  open: boolean
}) {
  const { t } = useI18n()
  const c = t.cron
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [preset, setPreset] = useState<SchedulePreset>('daily')
  const [customExpr, setCustomExpr] = useState('')
  const [deliver, setDeliver] = useState<DeliveryTarget>(DEFAULT_DELIVER)
  const [saving, setSaving] = useState(false)

  // Seed the form whenever it opens (edit → the job's values; create → defaults).
  useEffect(() => {
    if (!open) {
      return
    }
    if (job) {
      const expr = jobScheduleExpr(job)
      const p = presetForExpr(expr)
      setName(jobName(job))
      setPrompt(job.prompt ?? '')
      setPreset(p)
      setCustomExpr(p === 'custom' ? expr : '')
      setDeliver(jobDeliver(job))
    } else {
      setName('')
      setPrompt('')
      setPreset('daily')
      setCustomExpr('')
      setDeliver(DEFAULT_DELIVER)
    }
  }, [open, job])

  const submit = async () => {
    const schedule = preset === 'custom' ? customExpr.trim() : exprForPreset(preset)
    if (!prompt.trim() || !schedule) {
      notify({ kind: 'warning', message: c.promptScheduleRequired })
      return
    }
    setSaving(true)
    const ok = await saveCron(job?.id ?? null, { name: name.trim(), prompt: prompt.trim(), schedule, deliver })
    setSaving(false)
    if (ok) {
      notify({ kind: 'success', message: job ? c.updated : c.created })
      onOpenChange(false)
    }
  }

  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetContent className="max-h-[min(38rem,90vh)] gap-3 overflow-y-auto rounded-t-xl p-4" side="bottom">
        <SheetHeader className="p-0">
          <SheetTitle>{job ? c.editTitle : c.createTitle}</SheetTitle>
          <SheetDescription>{job ? c.editDesc : c.createDesc}</SheetDescription>
        </SheetHeader>

        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted-foreground">{c.nameLabel}</span>
          <Input onChange={e => setName(e.target.value)} placeholder={c.namePlaceholder} value={name} />
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted-foreground">{c.promptLabel}</span>
          <Textarea className="min-h-24" onChange={e => setPrompt(e.target.value)} placeholder={c.promptPlaceholder} value={prompt} />
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted-foreground">{c.frequencyLabel}</span>
          <Select onValueChange={v => setPreset(v as SchedulePreset)} value={preset}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SCHEDULE_OPTIONS.map(option => (
                <SelectItem key={option.value} value={option.value}>
                  {c.scheduleLabels[option.value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>

        {preset === 'custom' && (
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">{c.customScheduleLabel}</span>
            <Input onChange={e => setCustomExpr(e.target.value)} placeholder={c.customPlaceholder} value={customExpr} />
            <span className="mt-1 block text-xs text-muted-foreground">{c.customHint}</span>
          </label>
        )}

        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted-foreground">{c.deliverLabel}</span>
          <Select onValueChange={v => setDeliver(v as DeliveryTarget)} value={deliver}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DELIVERY_VALUES.map(value => (
                <SelectItem key={value} value={value}>
                  {c.deliveryLabels[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>

        <div className="mt-1 flex gap-2">
          <Button className="flex-1" onClick={() => onOpenChange(false)} variant="ghost">
            {t.common.cancel}
          </Button>
          <Button className="flex-1" disabled={saving} onClick={() => void submit()}>
            {job ? c.saveChanges : c.createAction}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  )
}
