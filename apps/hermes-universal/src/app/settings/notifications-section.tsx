import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { useI18n } from '@/i18n'
import { useStore } from '@/store/atom'
import { $hapticsMuted } from '@/store/haptics'
import {
  $nativeNotifyPrefs,
  NATIVE_NOTIFICATION_KINDS,
  sendTestNativeNotification,
  setNativeNotifyEnabled,
  setNativeNotifyKind
} from '@/store/native-notifications'
import { notify } from '@/store/notifications'

import { ListRow, SettingsContent } from './primitives'

// Notifications (Jc9): binds the native-notification prefs store + haptics.
// completion-sound is deferred FIXME(J9) (needs an audio asset + player).
export function NotificationsSection() {
  const { t } = useI18n()
  const c = t.settings.notifications
  const prefs = useStore($nativeNotifyPrefs)
  const hapticsMuted = useStore($hapticsMuted)
  const [testing, setTesting] = useState(false)

  const sendTest = async () => {
    setTesting(true)
    try {
      const ok = await sendTestNativeNotification(c.testTitle, c.testBody)
      notify({ kind: ok ? 'success' : 'warning', message: ok ? c.testSent : c.testUnsupported })
    } finally {
      setTesting(false)
    }
  }

  return (
    <SettingsContent>
      <p className="pt-3 pb-1 text-xs text-muted-foreground">{c.intro}</p>

      <ListRow
        action={<Switch checked={prefs.enabled} onCheckedChange={setNativeNotifyEnabled} />}
        description={c.enableAllDesc}
        title={c.enableAll}
      />

      {NATIVE_NOTIFICATION_KINDS.map(kind => (
        <ListRow
          key={kind}
          action={
            <Switch
              checked={prefs.kinds[kind]}
              disabled={!prefs.enabled}
              onCheckedChange={on => setNativeNotifyKind(kind, on)}
            />
          }
          description={c.kinds[kind].description}
          title={c.kinds[kind].label}
        />
      ))}

      <p className="py-2 text-xs text-muted-foreground">{c.focusedHint}</p>

      <Button className="w-full" disabled={testing} onClick={() => void sendTest()} variant="outline">
        {c.test}
      </Button>

      <div className="mt-6">
        <ListRow
          action={<Switch checked={hapticsMuted} onCheckedChange={muted => $hapticsMuted.set(muted)} />}
          title={t.titlebar.muteHaptics}
        />
      </div>
    </SettingsContent>
  )
}
