import { ListRow } from '@/app/settings/primitives'
import { settingRowElementId } from '@/app/settings/setting-row-id'
import { Switch } from '@/components/ui/switch'
import { useI18n } from '@/i18n'
import { triggerHaptic } from '@/lib/haptics'
import { useStore } from '@/store/atom'
import { $quickEntry, saveQuickEntrySettings } from '@/store/quick-entry'

import { canUseQuickEntry } from './quick-entry'

/**
 * Quick Entry's compact settings row — enable switch only.
 *
 * The free-text accelerator lives in `QuickEntrySettings` (Advanced). This row
 * is the discoverable on/off for the same preference Rust registers.
 */
export function QuickEntryRow() {
  const { t } = useI18n()
  const copy = t.quickEntry
  const state = useStore($quickEntry)

  if (!canUseQuickEntry()) {
    return null
  }

  return (
    <ListRow
      action={
        <Switch
          aria-label={copy.settingsTitle}
          checked={state.enabled}
          onCheckedChange={on => {
            triggerHaptic('selection')
            void saveQuickEntrySettings({ enabled: on })
          }}
        />
      }
      description={`${copy.settingsDesc} ${copy.shortcutHint}`}
      id={settingRowElementId('advanced.quick-entry')}
      title={copy.settingsTitle}
    />
  )
}
