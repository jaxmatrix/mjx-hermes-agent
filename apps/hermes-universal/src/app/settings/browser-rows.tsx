import { Switch } from '@/components/ui/switch'
import { useI18n } from '@/i18n'
import { clearGuestData } from '@/lib/browser/host'
import { triggerHaptic } from '@/lib/haptics'
import { useStore } from '@/store/atom'
import {
  $browserCapabilities,
  $browserConsoleOpen,
  $browserSupported,
  $openLinksInApp,
  ensureBrowserCapabilities
} from '@/store/browser'
import { confirm } from '@/store/confirm'
import { notify } from '@/store/notifications'

import { ListRow } from './primitives'
import { settingRowElementId } from './settings-search'

/**
 * The in-app browser's four device-local rows (MJXHRM-447), in Settings ▸
 * Advanced beside keep-awake and background mode — the same KIND of setting: a
 * switch over a native lever with nothing to send to the gateway, and two
 * devices on one gateway want different answers.
 *
 * HIDDEN, not disabled, where there is no guest host. An always-failing control
 * is the thing the house rules reject, and `$browserSupported` is the honest
 * question (rule 10) — a desktop build whose child webview was refused has no
 * browser, and a phone with the native plugin does.
 */
export function BrowserRows() {
  const { t } = useI18n()
  const copy = t.browser
  const supported = useStore($browserSupported)
  const caps = useStore($browserCapabilities)
  const openInApp = useStore($openLinksInApp)
  const consoleOpen = useStore($browserConsoleOpen)

  // The descriptor is asked for lazily everywhere else; the settings page is a
  // place the user has deliberately opened, so paying one IPC round-trip to
  // know whether to render at all is honest.
  void ensureBrowserCapabilities()

  if (!supported) {
    return null
  }

  // The store the platform actually gave us, said plainly rather than implied.
  const storeNote =
    caps?.isolatedStore === 'shared'
      ? copy.sharedCookies
      : caps?.isolatedStore === 'ephemeral'
        ? copy.ephemeralStore
        : copy.isolatedStoreDescription

  return (
    <>
      <ListRow
        action={
          <Switch
            aria-label={copy.openLinksInApp}
            checked={openInApp}
            onCheckedChange={on => {
              triggerHaptic('selection')
              $openLinksInApp.set(on)
            }}
          />
        }
        description={copy.openLinksInAppDescription}
        id={settingRowElementId('advanced.browser-links')}
        title={copy.openLinksInApp}
      />

      <ListRow
        description={storeNote}
        id={settingRowElementId('advanced.browser-store')}
        title={copy.isolatedStore}
      />

      <ListRow
        action={
          <Switch
            aria-label={copy.consoleDefault}
            checked={consoleOpen}
            onCheckedChange={on => {
              triggerHaptic('selection')
              $browserConsoleOpen.set(on)
            }}
          />
        }
        description={copy.consoleDefaultDescription}
        id={settingRowElementId('advanced.browser-console')}
        title={copy.consoleDefault}
      />

      <ListRow
        action={
          <button
            className="rounded-md border border-(--ui-stroke-tertiary) px-2 py-1 text-xs hover:bg-(--ui-control-hover-background)"
            onClick={async () => {
              if (!(await confirm({ destructive: true, title: copy.clearDataConfirm }))) {
                return
              }

              await clearGuestData().catch(() => undefined)
              notify({ message: copy.cleared })
            }}
            type="button"
          >
            {copy.clearData}
          </button>
        }
        description={copy.clearDataDescription}
        id={settingRowElementId('advanced.browser-clear')}
        title={copy.clearData}
      />
    </>
  )
}
