import { useEffect, useState } from 'react'

import { ListRow, LoadingState, SettingsContent } from '@/app/settings/primitives'
import { Button } from '@/components/ui/button'
import { getUsageAnalytics } from '@/hermes'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import type { AnalyticsResponse } from '@/types/hermes'

const PERIODS = [7, 30, 90]
const fmt = (n: number | null | undefined) => (n == null ? '—' : n.toLocaleString('en-US'))
const money = (n: number) => `$${n.toFixed(2)}`

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-sm font-semibold text-foreground">{value}</div>
    </div>
  )
}

export function UsagePanel() {
  const { t } = useI18n()
  const cc = t.commandCenter
  const [days, setDays] = useState(30)
  const [data, setData] = useState<AnalyticsResponse | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    let cancelled = false
    void getUsageAnalytics(days)
      .then(res => !cancelled && setData(res))
      .catch(() => !cancelled && setData(null))
      .finally(() => !cancelled && setLoading(false))
    return () => void (cancelled = true)
  }, [days])

  return (
    <SettingsContent>
      <div className="mt-3 grid grid-cols-3 gap-2">
        {PERIODS.map(p => (
          <Button
            key={p}
            className={cn(days === p && 'border-primary text-foreground')}
            onClick={() => setDays(p)}
            size="sm"
            variant={days === p ? 'outline' : 'ghost'}
          >
            {cc.days(p)}
          </Button>
        ))}
      </div>

      {loading && !data ? (
        <LoadingState label={cc.loadingUsage} />
      ) : !data ? (
        <p className="py-10 text-center text-sm text-muted-foreground">{cc.noUsage(days)}</p>
      ) : (
        <>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <Stat label={cc.statSessions} value={fmt(data.totals.total_sessions)} />
            <Stat label={cc.statApiCalls} value={fmt(data.totals.total_api_calls)} />
            <Stat label={cc.statTokens} value={`${fmt(data.totals.total_input)} / ${fmt(data.totals.total_output)}`} />
            <Stat label={cc.statCost} value={money(data.totals.total_estimated_cost)} />
          </div>

          <div className="mt-5">
            <ListRow title={cc.topModels} />
            {data.by_model.length === 0 ? (
              <p className="py-3 text-center text-xs text-muted-foreground">{cc.noModelUsage}</p>
            ) : (
              data.by_model.slice(0, 6).map(m => (
                <ListRow
                  key={m.model}
                  description={`${cc.actions(String(m.api_calls))} · ${money(m.estimated_cost)}`}
                  title={<span className="truncate">{m.model}</span>}
                />
              ))
            )}
          </div>

          <div className="mt-5">
            <ListRow title={cc.topSkills} />
            {data.skills.top_skills.length === 0 ? (
              <p className="py-3 text-center text-xs text-muted-foreground">{cc.noSkillActivity}</p>
            ) : (
              data.skills.top_skills.slice(0, 6).map(s => (
                <ListRow key={s.skill} description={cc.actions(String(s.total_count))} title={<span className="truncate">{s.skill}</span>} />
              ))
            )}
          </div>
        </>
      )}
    </SettingsContent>
  )
}
