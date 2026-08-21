import { useState } from 'react'

import { useI18n } from '@/i18n'
import { AlertTriangle, X } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { useStore } from '@/store/atom'
import { $statusSnapshot } from '@/store/system-status'
import type { StatusResponse } from '@/types/hermes'

/**
 * App-wide warning bar for resource trouble the BACKEND has already classified
 * — memory pressure, suspected-OOM restarts and disk exhaustion off
 * `GET /api/status` (`gateway/memory_status.py`, `gateway/disk_status.py`).
 *
 * Every one of those signals used to die in the gateway's log files: a hosted
 * agent could be OOM-killed hourly, or fill its HERMES_HOME volume until SQLite
 * writes started failing, and universal looked perfectly healthy the whole time
 * (fleet incidents NS-608, OOF-2, OOF-107). The web dashboard closed the gap
 * with `web/src/components/MemoryPressureBanner.tsx`; this is the same contract
 * for the Tauri client, which had no surface for it at all — and neither does
 * apps/desktop, so this is capability rather than parity.
 *
 * The levels come from the backend and are never re-derived here. `pressure` is
 * an enum precisely so the client and the dashboard and the NAS availability
 * sweep cannot disagree when a threshold moves, and so a stale heartbeat can
 * report honest MB numbers while refusing to call them "critical". `unknown` is
 * absence of evidence, never "fine".
 *
 * Triggers, worst-first (identical ordering to the dashboard's):
 *   1. disk critical  — silent data loss beats an imminent restart.
 *   2. memory critical
 *   3. suspected-OOM restart (post-mortem; a heuristic, and the copy says so)
 *   4. disk elevated / 5. memory elevated — early warnings.
 *
 * Dismissal semantics, mirrored from the dashboard component:
 *   - EVERY dismissal key embeds the reporting `boot_id`, so a gateway restart
 *     invalidates all of them. Without it, dismissing `critical`, restarting,
 *     and coming back still-critical would hide the NEW incident — and mask the
 *     OOM notice with it, since `critical` outranks `oom_restart`.
 *   - Within one boot a dismissal masks only its own trigger: escalation
 *     (elevated → critical, either domain) re-opens immediately, because the
 *     next trigger in the cascade is not the dismissed one.
 *   - A confirmed recovery (`pressure` back to `ok`, NOT `unknown`) clears that
 *     domain's live dismissals so the next episode in the same boot surfaces
 *     again. Each domain recovers independently — a fixed disk must not
 *     un-dismiss a memory warning.
 */

const STORAGE_KEY = 'resourceBannerDismissed'

export type PressureTrigger = 'critical' | 'disk_critical' | 'disk_elevated' | 'elevated' | 'oom_restart'

const MEMORY_LIVE_TRIGGERS: PressureTrigger[] = ['critical', 'elevated']
const DISK_LIVE_TRIGGERS: PressureTrigger[] = ['disk_critical', 'disk_elevated']

/**
 * The triggers a status snapshot is currently asserting, worst-first.
 *
 * Pure and exported so the ordering — the part that decides WHICH warning a
 * user sees when two conditions hold at once — is testable without a DOM.
 */
export function activePressureTriggers(status: null | StatusResponse): PressureTrigger[] {
  const memory = status?.memory
  const disk = status?.disk
  const triggers: PressureTrigger[] = []

  if (disk?.pressure === 'critical') {
    triggers.push('disk_critical')
  }

  if (memory?.pressure === 'critical') {
    triggers.push('critical')
  }

  if (memory?.last_boot_suspected_oom) {
    triggers.push('oom_restart')
  }

  if (disk?.pressure === 'elevated') {
    triggers.push('disk_elevated')
  }

  if (memory?.pressure === 'elevated') {
    triggers.push('elevated')
  }

  return triggers
}

/**
 * The dismissal key for one trigger under one gateway life.
 *
 * A missing `boot_id` (a degraded `memory` block, or a gateway that predates
 * NS-656) degrades to a shared `unknown` bucket rather than throwing — the old
 * per-severity behaviour, never a crash.
 */
export function pressureDismissKey(trigger: PressureTrigger, bootId: null | string | undefined): string {
  return `${trigger}:${bootId ?? 'unknown'}`
}

function readDismissed(): string[] {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? '[]')

    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : []
  } catch {
    // A non-array or unparseable value is a clean reset, not a crash.
    return []
  }
}

function writeDismissed(entries: string[]): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(entries))
  } catch {
    /* private mode / quota — dismissal just doesn't survive a reload */
  }
}

/** Does a stored entry belong to one of these triggers, under ANY boot id? */
function entryMatches(triggers: PressureTrigger[]) {
  return (entry: string) => triggers.some(trigger => entry === trigger || entry.startsWith(`${trigger}:`))
}

export function ResourcePressureBanner() {
  const { t } = useI18n()
  const status = useStore($statusSnapshot)
  const memory = status?.memory
  const disk = status?.disk
  const pressure = memory?.pressure
  const diskPressure = disk?.pressure

  const [dismissed, setDismissed] = useState<string[]>(readDismissed)

  // Recovery reset, as a render-time state adjustment (the sanctioned React
  // pattern for reacting to a changed input without an effect): once a domain
  // is demonstrably back to `ok`, its dismissed live entries describe a PAST
  // episode — drop them so the next one is not silently hidden. Cross-boot
  // invalidation needs nothing here: boot_id is part of every key.
  const [prevPressure, setPrevPressure] = useState(pressure)
  const [prevDiskPressure, setPrevDiskPressure] = useState(diskPressure)

  if (pressure !== prevPressure || diskPressure !== prevDiskPressure) {
    setPrevPressure(pressure)
    setPrevDiskPressure(diskPressure)

    const recovered: ((entry: string) => boolean)[] = []

    if (pressure === 'ok') {
      recovered.push(entryMatches(MEMORY_LIVE_TRIGGERS))
    }

    if (diskPressure === 'ok') {
      recovered.push(entryMatches(DISK_LIVE_TRIGGERS))
    }

    if (recovered.length > 0) {
      const isRecovered = (entry: string) => recovered.some(match => match(entry))

      if (dismissed.some(isRecovered)) {
        const next = dismissed.filter(entry => !isRecovered(entry))

        writeDismissed(next)
        setDismissed(next)
      }
    }
  }

  // Dismissal cascades: hiding the top trigger surfaces the next one rather
  // than silencing everything.
  const trigger =
    activePressureTriggers(status).find(entry => !dismissed.includes(pressureDismissKey(entry, memory?.boot_id))) ??
    null

  if (!trigger) {
    return null
  }

  const dismissKey = pressureDismissKey(trigger, memory?.boot_id)
  const critical = trigger === 'critical' || trigger === 'disk_critical'

  const dismiss = () => {
    setDismissed(prev => {
      const next = prev.includes(dismissKey) ? prev : [...prev, dismissKey]

      writeDismissed(next)

      return next
    })
  }

  const freeMb = disk?.free_mb
  const diskSuffix = typeof freeMb === 'number' ? t.resourcePressure.diskFree(Math.round(freeMb)) : ''

  const message =
    trigger === 'disk_critical'
      ? `${t.resourcePressure.diskCritical}${diskSuffix}`
      : trigger === 'disk_elevated'
        ? `${t.resourcePressure.diskElevated}${diskSuffix}`
        : trigger === 'oom_restart'
          ? t.resourcePressure.oomRestart
          : critical
            ? t.resourcePressure.memoryCritical
            : t.resourcePressure.memoryElevated

  return (
    <div
      className={cn(
        'flex shrink-0 items-center gap-2 border-b px-4 py-1.5 text-xs',
        critical
          ? 'border-destructive/30 bg-destructive/10 text-destructive'
          : 'border-primary/30 bg-primary/10 text-primary'
      )}
      data-testid="resource-pressure-banner"
      data-trigger={trigger}
      role="alert"
    >
      <AlertTriangle className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1">{message}</span>
      <button
        aria-label={t.resourcePressure.dismiss}
        className="shrink-0 opacity-70 hover:opacity-100"
        onClick={dismiss}
        type="button"
      >
        <X className="size-3.5" />
      </button>
    </div>
  )
}
