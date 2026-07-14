import type { ComponentType } from 'react'

import { useI18n } from '@/i18n'
import { Archive, Bell, Globe, Info, Key, Keyboard, Paw } from '@/lib/icons'

import { SECTIONS } from './constants'

// The drill-in list model: the schema-driven config sections (from SECTIONS,
// includes appearance) followed by the custom, non-schema tabs. Each id maps to
// a `/settings/:id` detail route. Deferred tabs (gateway/providers/pet) are not
// listed until their gating tracks land.
export interface SettingsNavEntry {
  id: string
  label: string
  icon: ComponentType<{ className?: string }>
}

export function useSettingsNav(): SettingsNavEntry[] {
  const { t } = useI18n()
  const sectionLabels = t.settings.sections as Record<string, string>

  const configEntries: SettingsNavEntry[] = SECTIONS.map(section => ({
    id: section.id,
    icon: section.icon,
    label: sectionLabels[section.id] ?? section.label
  }))

  const customEntries: SettingsNavEntry[] = [
    { id: 'gateway', icon: Globe, label: t.settings.nav.gateway },
    { id: 'notifications', icon: Bell, label: t.settings.nav.notifications },
    { id: 'keys', icon: Key, label: t.settings.nav.apiKeys },
    { id: 'shortcuts', icon: Keyboard, label: t.shortcuts.title },
    { id: 'pet', icon: Paw, label: t.commandCenter.pets.title },
    { id: 'archived', icon: Archive, label: t.settings.nav.archivedChats },
    { id: 'about', icon: Info, label: t.settings.nav.about }
  ]

  return [...configEntries, ...customEntries]
}
