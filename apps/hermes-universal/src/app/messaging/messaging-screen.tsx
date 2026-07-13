import { useEffect, useState } from 'react'

import { EmptyState, ListRow, LoadingState, SettingsContent } from '@/app/settings/primitives'
import { SidebarTrigger } from '@/app/shell/sidebar'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { useI18n } from '@/i18n'
import { useStore } from '@/store/atom'
import { $messagingError, $messagingLoading, $platforms, refreshMessaging, setPlatformEnabled } from '@/store/messaging'
import type { MessagingPlatformInfo } from '@/types/hermes'

import { PlatformSheet } from './platform-sheet'

export function MessagingScreen() {
  const { t } = useI18n()
  const m = t.messaging
  const platforms = useStore($platforms)
  const loading = useStore($messagingLoading)
  const error = useStore($messagingError)
  const [detail, setDetail] = useState<MessagingPlatformInfo | null>(null)

  useEffect(() => void refreshMessaging(), [])

  const stateLabel = (platform: MessagingPlatformInfo) => {
    const key = platform.state as keyof typeof m.states
    return (key && m.states[key]) || (platform.configured ? m.credentialsSet : m.needsSetup)
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b border-border p-3">
        <SidebarTrigger className="md:hidden" />
        <h1 className="min-w-0 flex-1 truncate text-base font-semibold text-foreground">{t.nav.messaging}</h1>
      </header>

      {loading && platforms.length === 0 ? (
        <LoadingState label={m.loading} />
      ) : error && platforms.length === 0 ? (
        <SettingsContent>
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <span className="text-sm text-muted-foreground">{m.loadFailed}</span>
            <Button onClick={() => void refreshMessaging()} size="sm">
              {t.common.retry}
            </Button>
          </div>
        </SettingsContent>
      ) : platforms.length === 0 ? (
        <SettingsContent>
          <EmptyState title={m.loadFailed} />
        </SettingsContent>
      ) : (
        <SettingsContent>
          <div className="pt-1">
            {platforms.map(platform => (
              <ListRow
                key={platform.id}
                description={stateLabel(platform)}
                title={
                  <button className="truncate text-left hover:text-primary" onClick={() => setDetail(platform)} type="button">
                    {platform.name}
                  </button>
                }
                action={
                  <Switch
                    aria-label={platform.enabled ? m.disableAria(platform.name) : m.enableAria(platform.name)}
                    checked={platform.enabled}
                    onCheckedChange={on => void setPlatformEnabled(platform.id, on)}
                  />
                }
              />
            ))}
          </div>
          <p className="px-1 pt-4 text-xs text-muted-foreground">{m.restartToApply}</p>
        </SettingsContent>
      )}

      <PlatformSheet onOpenChange={open => !open && setDetail(null)} open={detail !== null} platform={detail} />
    </div>
  )
}
