import { useEffect, useState } from 'react'

import { EmptyState, LoadingState, SettingsContent } from '@/app/settings/primitives'
import { SidebarTrigger } from '@/app/shell/sidebar'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { getSessionMessages, listSessions } from '@/hermes'
import { useI18n } from '@/i18n'
import { Refresh } from '@/lib/icons'
import { openExternalLink } from '@/lib/external-link'

import { type ArtifactFilter, ARTIFACT_FILTERS, type ArtifactRecord, collectArtifactsForSession } from './artifact-utils'

// How many recent sessions to scan for artifacts. Bounded for phone/LAN perf —
// FIXME(K4): paginate / lazy-load older sessions.
const SCAN_SESSIONS = 15

export function ArtifactsScreen() {
  const { t } = useI18n()
  const a = t.artifacts
  const [artifacts, setArtifacts] = useState<ArtifactRecord[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [filter, setFilter] = useState<ArtifactFilter>('all')

  const load = async () => {
    setArtifacts(null)
    setFailed(false)
    try {
      const { sessions } = await listSessions(SCAN_SESSIONS, 0, 'exclude', 'recent')
      const perSession = await Promise.allSettled(
        sessions.map(async session => {
          const { messages } = await getSessionMessages(session.id)
          return collectArtifactsForSession(session, messages)
        })
      )
      const all = perSession.flatMap(r => (r.status === 'fulfilled' ? r.value : []))
      all.sort((x, y) => y.timestamp - x.timestamp)
      setArtifacts(all)
    } catch {
      setFailed(true)
    }
  }

  useEffect(() => void load(), [])

  const shown = (artifacts ?? []).filter(item => filter === 'all' || item.kind === filter)
  const tabLabel: Record<ArtifactFilter, string> = {
    all: a.tabAll,
    image: a.tabImages,
    file: a.tabFiles,
    link: a.tabLinks
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b border-border p-3">
        <SidebarTrigger className="md:hidden" />
        <h1 className="min-w-0 flex-1 truncate text-base font-semibold text-foreground">{t.nav.artifacts}</h1>
        <Button aria-label={a.refresh} onClick={() => void load()} size="icon-sm" variant="ghost">
          <Refresh className="size-5" />
        </Button>
      </header>

      <div className="border-b border-border px-3 py-2">
        <Tabs onValueChange={v => setFilter(v as ArtifactFilter)} value={filter}>
          <TabsList className="w-full">
            {ARTIFACT_FILTERS.map(f => (
              <TabsTrigger className="flex-1" key={f} value={f}>
                {tabLabel[f]}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>

      {artifacts === null && !failed ? (
        <LoadingState label={a.indexing} />
      ) : failed ? (
        <SettingsContent>
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <span className="text-sm text-muted-foreground">{a.failedLoad}</span>
            <Button onClick={() => void load()} size="sm">
              {t.common.retry}
            </Button>
          </div>
        </SettingsContent>
      ) : shown.length === 0 ? (
        <SettingsContent>
          <EmptyState description={a.noArtifactsDesc} title={a.noArtifactsTitle} />
        </SettingsContent>
      ) : (
        <SettingsContent>
          {/* Images in a grid; files/links as rows. */}
          {shown.some(item => item.kind === 'image') && (
            <div className="grid grid-cols-3 gap-2 pt-3">
              {shown
                .filter(item => item.kind === 'image')
                .map(item => (
                  <button
                    className="aspect-square overflow-hidden rounded-lg border border-border bg-muted"
                    key={item.id}
                    onClick={() => void openExternalLink(item.href)}
                    type="button"
                  >
                    <img alt={item.label} className="size-full object-cover" loading="lazy" src={item.href} />
                  </button>
                ))}
            </div>
          )}
          <div className="pt-2">
            {shown
              .filter(item => item.kind !== 'image')
              .map(item => (
                <button
                  className="flex w-full items-center gap-3 border-b border-border/60 py-3 text-left last:border-b-0"
                  key={item.id}
                  onClick={() => void openExternalLink(item.href)}
                  type="button"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-foreground">{item.label}</span>
                    <span className="block truncate text-xs text-muted-foreground">{item.value}</span>
                  </span>
                  <span className="shrink-0 text-[0.65rem] text-muted-foreground uppercase">
                    {item.kind === 'file' ? a.kindFile : a.kindLink}
                  </span>
                </button>
              ))}
          </div>
        </SettingsContent>
      )}
    </div>
  )
}
