import { SECTIONS } from './constants'
import { settingsSubpages } from './subpages'
import type { SettingsView } from './types'

/**
 * Map a Workspace / surface nav GROUP id to the SettingsView used by
 * `settingsSubpages()`. Nav spells keyboard shortcuts `shortcuts`; the
 * subpage table keys them `keybinds`.
 */
export function navGroupToSettingsView(groupId: string): SettingsView | null {
  if (groupId === 'shortcuts') {
    return 'keybinds'
  }

  if (
    groupId === 'about' ||
    groupId === 'billing' ||
    groupId === 'connections' ||
    groupId === 'gateway' ||
    groupId === 'keys' ||
    groupId === 'notifications' ||
    groupId === 'providers' ||
    groupId === 'sessions' ||
    groupId === 'vault'
  ) {
    return groupId
  }

  if (SECTIONS.some(section => section.id === groupId)) {
    return `config:${groupId}`
  }

  return null
}

/** First section id to open when selecting a nav group (child or first subpage). */
export function defaultSectionForNavGroup(group: {
  id: string
  children?: readonly { id: string }[]
}): string {
  if (group.children?.[0]) {
    return group.children[0].id
  }

  const view = navGroupToSettingsView(group.id)

  if (view) {
    const pages = settingsSubpages(view)

    if (pages.length > 1) {
      return `${group.id}/${pages[0]!.id}`
    }
  }

  return group.id
}

/** Subpage segment for a persisted section path (`gateway/devices` → `devices`). */
export function settingsSubpageSegment(section: string): string | undefined {
  const parts = section.split('/')

  return parts.length > 1 ? parts.slice(1).join('/') : undefined
}
