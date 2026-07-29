import { getVersion } from '@tauri-apps/api/app'
import { useEffect, useState } from 'react'

import { Wordmark } from '@/components/brand/wordmark'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import { openExternalLink } from '@/lib/external-link'
import { useStore } from '@/store/atom'
import { $status } from '@/store/connection'

import { ListRow, SettingsContent } from './primitives'

// Deliberately still the upstream repo: these are the releases this build
// actually comes from, and a rebranded dead link would be worse than an honest
// one. Revisit if the white-label ever ships its own release channel.
const RELEASE_NOTES_URL = 'https://github.com/NousResearch/hermes-agent/releases'

// About (Jc12): app version + backend version + release notes. Self-update and
// uninstall have no mobile analog (app-store managed) and are omitted.
export function AboutSection() {
  const { t } = useI18n()
  const a = t.settings.about
  const status = useStore($status)
  const [appVersion, setAppVersion] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void getVersion()
      .then(v => !cancelled && setAppVersion(v))
      .catch(() => !cancelled && setAppVersion(null))

    return () => void (cancelled = true)
  }, [])

  return (
    <SettingsContent>
      <div className="flex flex-col items-center gap-1 pt-8 pb-4 text-center">
        <Wordmark size="md" />
        <div className="text-sm text-muted-foreground">{appVersion ? a.version(appVersion) : a.versionUnavailable}</div>
      </div>

      {status?.version && <ListRow description={String(status.version)} title="Gateway" />}

      <Button className="mt-4 w-full" onClick={() => void openExternalLink(RELEASE_NOTES_URL)} variant="outline">
        {a.releaseNotes}
      </Button>
    </SettingsContent>
  )
}
