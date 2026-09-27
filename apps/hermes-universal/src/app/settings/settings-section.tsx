import { Link, useParams } from 'react-router'

import { PetSection } from '@/app/pet/pet-section'
import { settingRowElementId } from '@/app/settings/setting-row-id'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { useI18n } from '@/i18n'
import { triggerHaptic } from '@/lib/haptics'
import { ChevronLeft } from '@/lib/icons'
import { IS_DESKTOP } from '@/lib/platform'
import { useStore } from '@/store/atom'
import { $backgroundMode, setBackgroundMode } from '@/store/background-mode'
import { $terminalHostPreference, setTerminalHostPreference } from '@/store/terminals'
import type { TerminalHostPreference } from '@/transport/terminal-transport'

import { AboutSettings } from './about-settings'
import { AppearanceSettings } from './appearance-settings'
import { BillingSettings } from './billing'
import { BrowserRows } from './browser-rows'
import { ConfigSettings } from './config-settings'
import { GatewaySettings } from './gateway-settings'
import { KeybindSettings } from './keybind-settings'
import { KeysSection } from './keys-section'
import { NotificationsSettings } from './notifications-settings'
import { PluginsSettings } from './plugins-settings'
import { EmptyState, ListRow, SettingsContent } from './primitives'
import { ProvidersSettings } from './providers-settings'
import { SessionsSettings } from './sessions-settings'
import { useSettingsNav } from './settings-nav'
import { useDeepLinkHighlight } from './use-deep-link-highlight'

// "Shell runs on" override for `resolveTerminalTransportKind` (transport/terminal-
// transport.ts) — a device-local preference, not a schema config field, so it
// sits above ConfigSettings on the Workspace shell subpage.
function TerminalHostRow() {
  const preference = useStore($terminalHostPreference)

  const options = [
    { id: 'auto', label: 'Auto' },
    { id: 'device', label: 'This device' },
    { id: 'gateway', label: 'Gateway' }
  ] as const satisfies readonly { id: TerminalHostPreference; label: string }[]

  return (
    <ListRow
      action={
        <Select onValueChange={value => setTerminalHostPreference(value as TerminalHostPreference)} value={preference}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map(option => (
              <SelectItem key={option.id} value={option.id}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      }
      description="Where the agent shell runs for this device."
      id={settingRowElementId('workspace.terminal-host')}
      title="Shell runs on"
    />
  )
}

// Background mode — Workspace-only device row (absent from ConfigSettings).
// Desktop-only: nothing to hide behind on a phone.
function BackgroundModeRow() {
  const backgroundMode = useStore($backgroundMode)

  return (
    <ListRow
      action={
        <Switch
          aria-label="Keep running in background"
          checked={backgroundMode === true}
          onCheckedChange={on => {
            triggerHaptic('selection')
            setBackgroundMode(on)
          }}
        />
      }
      description="Keep Hermes running when the last window closes."
      id={settingRowElementId('advanced.background-mode')}
      title="Keep running in background"
    />
  )
}

/** Schema config sections that share ConfigSettings + settingsSubpages filtering. */
const CONFIG_SETTINGS_SECTIONS = new Set([
  'advanced',
  'browser',
  'chat',
  'memory',
  'model',
  'safety',
  'voice',
  'workspace'
])

function ConfigSettingsBody({ sectionId, subpage }: { sectionId: string; subpage?: string }) {
  const showTerminalHost = sectionId === 'workspace' && (subpage === undefined || subpage === 'shell')
  const showBackgroundMode = IS_DESKTOP && sectionId === 'advanced' && (subpage === undefined || subpage === 'desktop')
  // In-app browser host rows — advanced device chrome, not mixed into other tabs.
  const showBrowserRows = sectionId === 'advanced' && (subpage === undefined || subpage === 'desktop')

  return (
    <>
      {(showTerminalHost || showBackgroundMode || showBrowserRows) && (
        <SettingsContent>
          {showTerminalHost ? <TerminalHostRow /> : null}
          {showBackgroundMode ? <BackgroundModeRow /> : null}
          {showBrowserRows ? <BrowserRows /> : null}
        </SettingsContent>
      )}
      <ConfigSettings activeSectionId={sectionId} subpage={subpage} />
    </>
  )
}

// The per-section body. Mirrors desktop Settings overlay (`settings/index.tsx`)
// so Workspace drawer options isolate the same subpage content.
const alwaysReady = () => true

export function SectionBody({
  onSectionChange,
  section
}: {
  /** Workspace (and other hosts without URL routing) use this so Providers
   *  in-page jumps update the active section id. */
  onSectionChange?: (section: string) => void
  section: string
}) {
  const { t } = useI18n()

  // `?setting=<id>` — the ⌘K deep link for the device-local rows, which have no
  // config key and so cannot ride config-section's `?field=` path. Mounted once
  // here rather than per row host: the route already picked the page, and the
  // hook polls for the DOM id, so it resolves whichever section renders it.
  useDeepLinkHighlight({ elementId: settingRowElementId, param: 'setting', ready: alwaysReady })

  // `section` may carry a sub-tab (`providers/keys` or `model/auxiliary`); split
  // so the switch keys off the top-level group and sub-views read the rest.
  const slash = section.indexOf('/')
  const group = slash === -1 ? section : section.slice(0, slash)
  const sub = slash === -1 ? undefined : section.slice(slash + 1)

  if (CONFIG_SETTINGS_SECTIONS.has(group)) {
    return <ConfigSettingsBody sectionId={group} subpage={sub} />
  }

  switch (group) {
    // Providers: Accounts (OAuth sign-in) + API keys + custom-endpoints sub-tabs.
    case 'providers':
      return (
        <ProvidersSettings
          onClose={() => undefined}
          onViewChange={view => {
            if (!onSectionChange) {
              return
            }

            if (view === 'accounts') {
              onSectionChange('providers')
            } else {
              onSectionChange(`providers/${view}`)
            }
          }}
          view={
            sub === 'keys'
              ? 'keys'
              : sub === 'custom-endpoints'
                ? 'custom-endpoints'
                : sub === 'local'
                  ? 'local'
                  : 'accounts'
          }
        />
      )

    // Appearance — desktop AppearanceSettings subpages (theme / typography / …).
    case 'appearance':
      return <AppearanceSettings subpage={sub} />

    // Notifications — alerts / sounds via NotificationsSettings subpages.
    case 'notifications':
      return <NotificationsSettings subpage={sub === 'sounds' ? 'sounds' : sub === 'alerts' ? 'alerts' : undefined} />

    // Tools & Keys (Jc10): env-var credentials, split into Tools + Settings
    // sub-tabs surfaced as nav children (desktop parity). Provider OAuth is D2.
    case 'keys':
      return <KeysSection view={sub === 'settings' ? 'settings' : 'tools'} />

    // Billing (MJXHRM-126): balance / plan / usage overview, the in-app plans
    // catalog (`?bview=plans`), top-up, auto-refill and the downgrade → undo
    // flow. Ported from apps/desktop/src/app/settings/billing.
    case 'billing':
      return <BillingSettings />

    // Gateways — same GatewaySettings subpages as the desktop Settings overlay.
    case 'gateway':
      return <GatewaySettings subpage={sub || 'connection'} />

    // Keyboard shortcuts — the full rebindable panel, ported from desktop.
    // Desktop's nav id for this page is `keybinds`; universal spells it
    // `shortcuts`. Both resolve so a desktop-shaped deep link (or a plugin
    // contribution copied from desktop) doesn't land on the empty state.
    case 'keybinds':

    case 'shortcuts':
      return (
        <KeybindSettings
          subpage={sub === 'hud-gesture' || sub === 'screen-capture' || sub === 'shortcuts' ? sub : undefined}
        />
      )

    // Pet gallery.
    case 'pet':
      return <PetSection />

    // Plugins (MJXHRM-129): the runtime plugin inventory + the disk-door switch.
    case 'plugins':
      return <PluginsSettings />

    // Archived chats / default directory (OTHER_SUBPAGES.sessions).
    case 'archived':

    case 'sessions':
      return (
        <SessionsSettings
          subpage={sub === 'default-directory' ? 'default-directory' : sub === 'archived' ? 'archived' : undefined}
        />
      )

    // About — updates / uninstall via AboutSettings subpages.
    case 'about':
      return <AboutSettings subpage={sub === 'uninstall' ? 'uninstall' : sub === 'updates' ? 'updates' : undefined} />

    default:
      // Genuinely unknown ids land here (a stale deep link, a typo'd route).
      // Every id either nav surface can produce is handled above.
      return (
        <SettingsContent>
          <EmptyState description={t.settings.config.emptyDesc} title={t.settings.config.emptyTitle} />
        </SettingsContent>
      )
  }
}

export function SettingsSection() {
  const { section = '' } = useParams()
  const nav = useSettingsNav()
  const entry = nav.find(e => e.id === section)
  const title = entry?.label ?? section

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-1 border-b border-border p-3">
        <Link
          aria-label="Back"
          className="-ms-1 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          to="/settings"
        >
          <ChevronLeft className="size-5 rtl:-scale-x-100" />
        </Link>
        <h1 className="text-base font-semibold text-foreground">{title}</h1>
      </header>
      <SectionBody section={section} />
    </div>
  )
}
