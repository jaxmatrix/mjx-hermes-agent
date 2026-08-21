import { useEffect } from 'react'

import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { useStore } from '@/store/atom'
import { $activeGatewayProfile, normalizeProfileKey, profileLabel, refreshProfiles } from '@/store/profile'
import { $profiles } from '@/store/profiles'
import { $settingsScopeOverride, setSettingsScope } from '@/store/settings-scope'

/** One profile chip. Ported from apps/desktop/src/app/settings/profile-scope.tsx. */
export function ScopeChip({ active, label, onSelect }: { active: boolean; label: string; onSelect: () => void }) {
  return (
    <button
      className={cn(
        'rounded-full border px-3 py-1 text-[length:var(--conversation-caption-font-size)] transition',
        active
          ? 'border-(--ui-stroke-secondary) bg-(--ui-bg-tertiary) text-(--ui-text-primary)'
          : 'border-(--ui-stroke-tertiary) bg-(--ui-bg-quinary) text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover)'
      )}
      onClick={onSelect}
      type="button"
    >
      {label}
    </button>
  )
}

/** Shared "Applies to" profile selector for the config-backed settings pages
 *  (Model, Workspace, Safety, Memory & Context, Voice, Tools & Keys) and the
 *  Messaging page. Backed by one nanostore ($settingsScopeOverride) so the
 *  selection persists across pages. Hidden with fewer than two profiles, so
 *  single-profile users never see it and every request keeps its unscoped
 *  default shape.
 *
 *  The chips carry `profileLabel`, not the raw name: a renamed default profile
 *  is "default" on the wire and its display name on screen. */
export function SettingsProfileScope({ className }: { className?: string }) {
  const { t } = useI18n()
  const scope = t.settings.profileScope
  const override = useStore($settingsScopeOverride)
  const active = useStore($activeGatewayProfile)
  const profiles = useStore($profiles)

  // Refresh lazily so a profile created elsewhere shows up; the cached list
  // paints immediately. Best-effort — a failure keeps the cached roster.
  useEffect(() => {
    void refreshProfiles().catch(() => undefined)
  }, [])

  if (profiles.length < 2) {
    return null
  }

  const selected = normalizeProfileKey(override ?? active)
  const selectedProfile = profiles.find(profile => normalizeProfileKey(profile.name) === selected)

  return (
    <div className={cn('grid gap-2', className)}>
      <div className="text-[length:var(--conversation-caption-font-size)] font-medium text-(--ui-text-secondary)">
        {scope.appliesTo}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {profiles.map(profile => (
          <ScopeChip
            active={normalizeProfileKey(profile.name) === selected}
            key={profile.name}
            label={profileLabel(profile)}
            onSelect={() => setSettingsScope(profile.name)}
          />
        ))}
      </div>
      {override !== null ? (
        <p className="text-[length:var(--conversation-caption-font-size)] leading-(--conversation-caption-line-height) text-(--ui-text-tertiary)">
          {scope.editsProfile(selectedProfile ? profileLabel(selectedProfile) : selected)}
        </p>
      ) : null}
    </div>
  )
}
