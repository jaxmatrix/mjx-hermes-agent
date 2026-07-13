import { useEffect, useRef, useState } from 'react'

import { EmptyState, ListRow, LoadingState, Pill, SettingsContent } from '@/app/settings/primitives'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { getSkillHubSources, previewSkillHub, scanSkillHub, searchSkillsHub } from '@/hermes'
import { useI18n } from '@/i18n'
import { Search } from '@/lib/icons'
import { useStore } from '@/store/atom'
import { $hubActions, installFromHub, uninstallFromHub, updateAllFromHub } from '@/store/hub'
import { notify } from '@/store/notifications'
import type { SkillHubInstalledEntry, SkillHubPreview, SkillHubResult, SkillHubScanResult } from '@/types/hermes'

type Installed = Record<string, SkillHubInstalledEntry>

export function HubTab() {
  const { t } = useI18n()
  const h = t.skills.hub
  const actions = useStore($hubActions)

  const [featured, setFeatured] = useState<SkillHubResult[]>([])
  const [installed, setInstalled] = useState<Installed>({})
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SkillHubResult[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [preview, setPreview] = useState<SkillHubResult | null>(null)
  const searchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const loadSources = async () => {
    setLoading(true)
    setFailed(false)
    try {
      const res = await getSkillHubSources()
      setFeatured(res.featured)
      setInstalled(res.installed)
    } catch {
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => void loadSources(), [])
  useEffect(() => () => clearTimeout(searchTimer.current), [])

  const onQuery = (value: string) => {
    setQuery(value)
    clearTimeout(searchTimer.current)
    if (!value.trim()) {
      setResults(null)
      return
    }
    searchTimer.current = setTimeout(() => {
      void searchSkillsHub(value.trim())
        .then(res => {
          setResults(res.results)
          setInstalled(prev => ({ ...prev, ...res.installed }))
        })
        .catch(() => notify({ kind: 'warning', message: h.searchFailed }))
    }, 350)
  }

  const isInstalled = (r: SkillHubResult) => Boolean(installed[r.name])

  const runInstall = async (r: SkillHubResult) => {
    notify({ kind: 'info', message: h.installStarted(r.name) })
    const ok = await installFromHub(r.identifier)
    if (!ok) {
      notify({ kind: 'warning', message: h.actionFailed })
    }
    void loadSources()
  }

  const runUninstall = async (r: SkillHubResult) => {
    notify({ kind: 'info', message: h.uninstallStarted(r.name) })
    const ok = await uninstallFromHub(r.name)
    if (!ok) {
      notify({ kind: 'warning', message: h.actionFailed })
    }
    void loadSources()
  }

  const shown = results ?? featured
  const anyUpdating = actions.__update_all__?.running

  return (
    <>
      <div className="border-b border-border px-3 py-2">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-9" onChange={e => onQuery(e.target.value)} placeholder={h.searchPlaceholder} value={query} />
        </div>
      </div>

      {loading ? (
        <LoadingState label={h.connectingHubs} />
      ) : failed ? (
        <SettingsContent>
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <span className="text-sm text-muted-foreground">{h.loadFailed}</span>
            <Button onClick={() => void loadSources()} size="sm">
              {t.common.retry}
            </Button>
          </div>
        </SettingsContent>
      ) : (
        <SettingsContent>
          {!results && (
            <div className="flex items-center justify-between gap-2 pt-2 pb-1">
              <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{h.featured}</span>
              <Button disabled={anyUpdating} onClick={() => void updateAllFromHub()} size="sm" variant="ghost">
                {anyUpdating ? h.updating : h.updateAll}
              </Button>
            </div>
          )}

          {shown.length === 0 ? (
            <EmptyState description={query ? h.noResults : h.landingHint} title={query ? h.noResults : h.featured} />
          ) : (
            <div>
              {shown.map(r => {
                const running = actions[r.identifier]?.running || actions[r.name]?.running
                const done = isInstalled(r)
                return (
                  <ListRow
                    key={r.identifier}
                    description={r.description}
                    title={
                      <button className="inline-flex items-center gap-2 text-left hover:text-primary" onClick={() => setPreview(r)} type="button">
                        <span className="truncate">{r.name}</span>
                        <Pill>{h.trust[r.trust_level as keyof typeof h.trust] ?? r.trust_level}</Pill>
                      </button>
                    }
                    action={
                      done ? (
                        <Button disabled={running} onClick={() => void runUninstall(r)} size="sm" variant="ghost">
                          {running ? h.uninstalling : h.uninstall}
                        </Button>
                      ) : (
                        <Button disabled={running} onClick={() => void runInstall(r)} size="sm" variant="outline">
                          {running ? h.installing : h.install}
                        </Button>
                      )
                    }
                  />
                )
              })}
            </div>
          )}
        </SettingsContent>
      )}

      <PreviewSheet onOpenChange={open => !open && setPreview(null)} result={preview} />
    </>
  )
}

function PreviewSheet({ onOpenChange, result }: { onOpenChange: (open: boolean) => void; result: SkillHubResult | null }) {
  const { t } = useI18n()
  const h = t.skills.hub
  const [data, setData] = useState<SkillHubPreview | null>(null)
  const [scan, setScan] = useState<SkillHubScanResult | null>(null)
  const [scanning, setScanning] = useState(false)

  useEffect(() => {
    if (!result) {
      return
    }
    setData(null)
    setScan(null)
    let cancelled = false
    void previewSkillHub(result.identifier)
      .then(p => !cancelled && setData(p))
      .catch(() => !cancelled && notify({ kind: 'warning', message: h.previewFailed }))
    return () => void (cancelled = true)
  }, [result, h.previewFailed])

  const runScan = async () => {
    if (!result) {
      return
    }
    setScanning(true)
    try {
      setScan(await scanSkillHub(result.identifier))
    } catch {
      notify({ kind: 'warning', message: h.scanFailed })
    } finally {
      setScanning(false)
    }
  }

  return (
    <Sheet onOpenChange={onOpenChange} open={result !== null}>
      <SheetContent className="max-h-[min(44rem,92vh)] gap-3 overflow-y-auto rounded-t-xl p-4" side="bottom">
        <SheetHeader className="p-0">
          <SheetTitle>{result?.name}</SheetTitle>
          <SheetDescription>{result?.description}</SheetDescription>
        </SheetHeader>

        <Button className="w-full" disabled={scanning} onClick={() => void runScan()} size="sm" variant="outline">
          {scanning ? h.scanning : h.scan}
        </Button>

        {scan && (
          <div className="rounded-lg border border-border p-3 text-sm">
            <div className="font-medium text-foreground">
              {scan.verdict === 'safe' ? h.verdictSafe : scan.verdict === 'dangerous' ? h.verdictDangerous : h.verdictCaution}
              {' · '}
              {scan.findings.length ? h.findings(scan.findings.length) : h.noFindings}
            </div>
            {scan.summary && <div className="mt-1 text-xs text-muted-foreground">{scan.summary}</div>}
          </div>
        )}

        {data ? (
          <pre className="overflow-x-auto rounded-lg bg-muted p-3 font-mono text-xs whitespace-pre-wrap text-muted-foreground">
            {data.skill_md || h.noReadme}
          </pre>
        ) : (
          <p className="py-6 text-center text-sm text-muted-foreground">{h.searching}</p>
        )}
      </SheetContent>
    </Sheet>
  )
}
