import { getVersion } from '@tauri-apps/api/app'
import { useEffect, useState } from 'react'

import { BrandMark } from '@/components/brand-mark'
import { Button } from '@/components/ui/button'
import { type Translations, useI18n } from '@/i18n'
import { openExternalLink } from '@/lib/external-link'
import { CheckCircle2, Download, ExternalLink, Loader2, RefreshCw } from '@/lib/icons'
import { IS_ANDROID, IS_IOS } from '@/lib/platform'
import { openAppDownload } from '@/lib/updates'
import { cn } from '@/lib/utils'
import { useStore } from '@/store/atom'
import { $status } from '@/store/connection'
import {
  $appUpdate,
  $appUpdateChecking,
  $appUpdateFailed,
  $appUpdateInstallError,
  $appUpdateInstalling,
  $appUpdateProgress,
  runUpdateCheck,
  runUpdateInstall
} from '@/store/updates'

import { ListRow, SectionHeading, SettingsContent } from './primitives'

const RELEASE_NOTES_URL = 'https://github.com/NousResearch/hermes-agent/releases'

// About (Jc12 / MJX-16 / MJXHRM-144): app version + backend version + release
// notes, plus the update surface. Where an update comes from is the native
// side's problem — a signed release bundle on desktop, the Play/App Store
// listing on mobile — so this only renders whatever `$appUpdate` reports.
//
// Three shapes come out of that:
//   * desktop  — `canSelfInstall`, so "Update now" downloads, verifies and
//                installs in place, then the app restarts into the new build.
//   * mobile   — `reason: 'store_pending'` while the listings are unpublished,
//                which renders a disabled, clearly-labelled mock of the store
//                button rather than a deep link into a 404.
//   * disabled — a `--no-default-features` build reports source 'disabled' and
//                the whole Updates block is hidden.

// Ported from apps/desktop/src/app/settings/about-settings.tsx.
function relativeTime(ms: number | undefined, a: Translations['settings']['about']) {
  if (!ms) {
    return a.never
  }

  const diff = Date.now() - ms

  if (diff < 60_000) {
    return a.justNow
  }

  if (diff < 3_600_000) {
    return a.minAgo(Math.round(diff / 60_000))
  }

  if (diff < 86_400_000) {
    return a.hoursAgo(Math.round(diff / 3_600_000))
  }

  return a.daysAgo(Math.round(diff / 86_400_000))
}

export function AboutSection() {
  const { t } = useI18n()
  const a = t.settings.about
  const status = useStore($status)
  const update = useStore($appUpdate)
  const checking = useStore($appUpdateChecking)
  const failed = useStore($appUpdateFailed)
  const installing = useStore($appUpdateInstalling)
  const progress = useStore($appUpdateProgress)
  const installError = useStore($appUpdateInstallError)
  const [appVersion, setAppVersion] = useState<null | string>(null)
  const [justChecked, setJustChecked] = useState(false)

  useEffect(() => {
    let cancelled = false
    void getVersion()
      .then(v => !cancelled && setAppVersion(v))
      .catch(() => !cancelled && setAppVersion(null))

    return () => void (cancelled = true)
  }, [])

  // Cheap: the native side answers from a 6h cache unless forced.
  useEffect(() => {
    void runUpdateCheck()
  }, [])

  // No update surface at all when the checks were compiled out (or the command
  // isn't there) — the page falls back to exactly its pre-MJX-6 form.
  const showUpdates = Boolean(update) && update?.source !== 'disabled'
  const storePending = update?.reason === 'store_pending'
  const canSelfInstall = Boolean(update?.canSelfInstall)

  const downloadLabel = IS_ANDROID ? a.openInPlayStore : IS_IOS ? a.openInAppStore : a.downloadUpdate

  // Absent Content-Length, there is no percentage to show — say "preparing"
  // rather than render a bar that never moves.
  const percent =
    progress && progress.total ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100)) : null

  const handleCheck = async () => {
    setJustChecked(false)

    const next = await runUpdateCheck(true)

    setJustChecked(Boolean(next))
  }

  let statusLine: string
  let statusTone: 'available' | 'error' | 'idle' = 'idle'

  if (installing) {
    statusLine = percent === null ? a.preparingDownload : a.downloadingPercent(percent)
    statusTone = 'available'
  } else if (installError) {
    statusLine = a.installFailed
    statusTone = 'error'
  } else if (checking) {
    statusLine = a.checking
  } else if (storePending) {
    statusLine = a.storePendingTitle
  } else if (failed || update?.reason === 'unreachable') {
    statusLine = a.cantReach
    statusTone = 'error'
  } else if (update?.reason === 'unparsed') {
    statusLine = a.cantRead
    statusTone = 'error'
  } else if (update?.updateAvailable) {
    statusLine = update.latestVersion ? a.newVersion(update.latestVersion) : a.updateReady(1)
    statusTone = 'available'
  } else if (update) {
    statusLine = a.onLatest
  } else {
    statusLine = a.tapCheck
  }

  return (
    <SettingsContent>
      <div className="flex flex-col items-center gap-3 pt-6 pb-2 text-center">
        <BrandMark className="size-16" />
        <div>
          <h2 className="text-lg font-semibold tracking-tight">{a.heading}</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {appVersion ? a.version(appVersion) : a.versionUnavailable}
          </p>
        </div>
      </div>

      <div className="mx-auto mt-4 w-full max-w-2xl">
        {status?.version && <ListRow description={String(status.version)} title="Gateway" />}

        {showUpdates ? (
          <>
            <SectionHeading icon={RefreshCw} title={a.updates} />

            <div
              className={cn(
                'rounded-xl border px-4 py-3 text-sm',
                statusTone === 'available' && 'border-primary/30 bg-primary/5 text-foreground',
                statusTone === 'error' && 'border-destructive/35 bg-destructive/5 text-destructive',
                statusTone === 'idle' && 'border-border/70 bg-muted/20 text-foreground'
              )}
            >
              <div className="flex items-start gap-2">
                {statusTone === 'available' ? (
                  <Download className="mt-0.5 size-4 shrink-0 text-primary" />
                ) : statusTone === 'error' ? null : (
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                )}
                <div className="min-w-0">
                  <p className="font-medium">{statusLine}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {storePending
                      ? IS_IOS
                        ? a.storePendingAppStore
                        : a.storePendingPlay
                      : `${a.lastChecked(relativeTime(update?.checkedAtMs, a))}${
                          justChecked && !checking ? a.justNowSuffix : ''
                        }`}
                  </p>
                </div>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-4">
                <Button
                  disabled={checking || installing}
                  onClick={() => void handleCheck()}
                  size="sm"
                  variant="textStrong"
                >
                  {checking ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
                  {checking ? a.checking : a.checkNow}
                </Button>

                {/* Mocked until the listings exist: shows exactly where the
                    update will come from, without pretending it's there. */}
                {storePending && (
                  <Button disabled size="sm">
                    <Download className="size-3" />
                    {`${downloadLabel}${a.comingSoonSuffix}`}
                  </Button>
                )}

                {update?.updateAvailable && canSelfInstall && (
                  <Button disabled={installing} onClick={() => void runUpdateInstall()} size="sm">
                    {installing ? <Loader2 className="size-3 animate-spin" /> : <Download className="size-3" />}
                    {installing ? a.installing : a.updateNow}
                  </Button>
                )}

                {update?.updateAvailable && !canSelfInstall && update.downloadUrl && (
                  <Button onClick={() => void openAppDownload(update.downloadUrl!, update.notesUrl)} size="sm">
                    <Download className="size-3" />
                    {downloadLabel}
                  </Button>
                )}

                {update?.notesUrl && (
                  <Button onClick={() => void openExternalLink(update.notesUrl!)} size="sm" variant="textStrong">
                    <ExternalLink className="size-3" />
                    {a.seeWhatsNew}
                  </Button>
                )}

                <Button
                  className="ml-auto"
                  onClick={() => void openExternalLink(RELEASE_NOTES_URL)}
                  size="sm"
                  variant="text"
                >
                  <ExternalLink className="size-3" />
                  {a.releaseNotes}
                </Button>
              </div>
            </div>

            {/* Desktop only: on mobile the store owns both the schedule and the
                install, so describing ours would be describing nothing. */}
            {canSelfInstall && (
              <ListRow description={a.automaticUpdatesDesc} hint={a.updateChannelSigned} title={a.automaticUpdates} />
            )}
          </>
        ) : (
          <Button className="mt-4 w-full" onClick={() => void openExternalLink(RELEASE_NOTES_URL)} variant="outline">
            {a.releaseNotes}
          </Button>
        )}
      </div>
    </SettingsContent>
  )
}
