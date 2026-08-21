/**
 * The searchable catalog of everything Settings can take you to.
 *
 * One list, three sources, so ⌘K can land on a *row* and not just a page:
 *  - schema config fields (`?field=`)   — built from the live schema × config
 *  - credential env vars (`?key=`)      — built from the live env-var map
 *  - client-pref rows (`?setting=`)     — the device-local knobs that have no
 *    config key at all (MJXHRM-489), declared statically below
 *
 * Ported from apps/desktop/src/app/settings/settings-search.ts, entry/target
 * shape kept so later syncs diff cleanly. One deliberate divergence: universal
 * routes Settings by PATH (`/settings/:section`), not by desktop's `?tab=`, so
 * desktop's `settingsSearchTargetQuery` is `settingsSearchTargetRoute` here.
 *
 * `CLIENT_PREF_SETTINGS` is the registration seam: a ticket that adds a
 * device-local settings row adds one entry here and gives its `ListRow` the
 * matching `id={settingRowElementId(...)}` — nothing else has to change for it
 * to become findable.
 */

import type { Translations } from '@/i18n/types'
import { type IconComponent, KeyRound, Settings2 } from '@/lib/icons'
import { IS_DESKTOP } from '@/lib/platform'
import type { ConfigFieldSchema, EnvVarInfo, HermesConfigRecord } from '@/types/hermes'

import { SECTIONS } from './constants'
import { credentialRowLabel } from './credential-key-ui'
import { fieldCopyForSchemaKey } from './field-copy'
import { prettyName, sectionFieldEntries, voiceFieldVisible } from './helpers'
import type { DesktopConfigSection } from './types'

/** Which Keys sub-tab an env var lives on — `null` means "not searchable". */
export type CredentialSettingsView = 'settings' | 'tools'

export interface SettingsSearchTarget {
  /** Schema config key → `?field=` (config-section's deep-link highlight). */
  field?: string
  /** Env var name → `?key=` (the Keys page expands + highlights the card). */
  key?: string
  /** Client-pref row id → `?setting=` (SectionBody's deep-link highlight). */
  setting?: string
  /** Route path under `/settings` — e.g. `chat`, `keys/settings`. */
  view: string
}

export interface SettingsSearchEntry {
  /** The page the row lives on, rendered after the label ("Voice: TTS provider"). */
  context: string
  description?: string
  icon: IconComponent
  id: string
  keywords: string[]
  label: string
  target: SettingsSearchTarget
}

/** DOM id a client-pref `ListRow` must carry to be deep-linkable. */
export const settingRowElementId = (setting: string): string => `setting-row-${setting}`

/** DOM id a credential card must carry to be deep-linkable. */
export const credentialRowElementId = (key: string): string => `credential-row-${key}`

/**
 * The device-local settings rows: real UI with no config key behind it, so
 * `sectionFieldEntries` can never see them. `view` is the `/settings/:view`
 * page the row renders on; `id` doubles as the `?setting=` deep-link value and
 * the row's DOM id (via `settingRowElementId`).
 */
export const CLIENT_PREF_SETTINGS: ReadonlyArray<{
  /** Hidden on mobile — the row itself is `IS_DESKTOP`-gated. */
  desktopOnly?: boolean
  id: string
  keywords: string[]
  label: (t: Translations) => string
  view: string
}> = [
  {
    id: 'appearance.language',
    keywords: ['language', 'locale', 'translation'],
    label: t => t.language.label,
    view: 'appearance'
  },
  {
    id: 'appearance.theme',
    keywords: ['theme', 'skin', 'colors', 'palette', 'dark', 'light'],
    label: t => t.settings.appearance.themeTitle,
    view: 'appearance'
  },
  {
    id: 'appearance.ui-scale',
    keywords: ['zoom', 'scale', 'text size', 'bigger', 'smaller'],
    label: t => t.settings.appearance.uiScaleTitle,
    view: 'appearance'
  },
  {
    desktopOnly: true,
    id: 'appearance.translucency',
    keywords: ['blur', 'transparent', 'vibrancy', 'window'],
    label: t => t.settings.appearance.translucencyTitle,
    view: 'appearance'
  },
  {
    id: 'appearance.terminal-font',
    keywords: ['terminal', 'font', 'monospace', 'typeface'],
    label: t => t.settings.appearance.terminalFontTitle,
    view: 'appearance'
  },
  {
    id: 'appearance.tool-view',
    keywords: ['tool calls', 'technical', 'product', 'display'],
    label: t => t.settings.appearance.toolViewTitle,
    view: 'appearance'
  },
  {
    id: 'appearance.backdrop',
    keywords: ['backdrop', 'chat', 'background', 'wallpaper'],
    label: t => t.settings.appearance.backdropTitle,
    view: 'appearance'
  },
  {
    id: 'appearance.intro-splash',
    keywords: ['intro', 'splash', 'wordmark', 'tagline', 'empty chat'],
    label: t => t.settings.appearance.introSplashTitle,
    view: 'appearance'
  },
  {
    id: 'appearance.reactions',
    keywords: ['reactions', 'emoji', 'messages'],
    label: t => t.settings.appearance.reactionsTitle,
    view: 'appearance'
  },
  {
    id: 'appearance.embeds',
    keywords: ['embeds', 'iframe', 'preview', 'links', 'youtube'],
    label: t => t.settings.appearance.embedsTitle,
    view: 'appearance'
  },
  {
    id: 'appearance.resize-rate',
    keywords: ['resize', 'throttle', 'smoothness', 'performance', 'fps'],
    label: t => t.settings.appearance.resizeRateTitle,
    view: 'appearance'
  },
  {
    id: 'appearance.resize-calm',
    keywords: ['resize', 'settle', 'calm', 'performance'],
    label: t => t.settings.appearance.resizeCalmTitle,
    view: 'appearance'
  },
  {
    id: 'chat.attachment-size',
    keywords: ['attachment', 'upload', 'image', 'size', 'megabytes', 'mb', 'preview'],
    label: t => t.settings.config.attachmentSizeTitle,
    view: 'chat'
  },
  {
    desktopOnly: true,
    id: 'advanced.keep-awake',
    keywords: ['keep awake', 'sleep', 'screensaver', 'idle', 'power'],
    label: t => t.settings.config.keepAwakeTitle,
    view: 'advanced'
  },
  {
    desktopOnly: true,
    id: 'advanced.background-mode',
    keywords: ['background', 'tray', 'close', 'quit', 'keep running'],
    label: t => t.settings.config.backgroundModeTitle,
    view: 'advanced'
  },
  {
    desktopOnly: true,
    id: 'advanced.quick-entry',
    keywords: ['quick entry', 'hotkey', 'global', 'capture'],
    label: t => t.quickEntry.settingsTitle,
    view: 'advanced'
  },
  {
    id: 'workspace.terminal-host',
    keywords: ['shell', 'terminal', 'runs on', 'device', 'gateway', 'remote'],
    label: t => t.settings.workspace.terminalHostTitle,
    view: 'workspace'
  }
]

/**
 * `/settings/<view>?<param>=<value>` — the URL a result navigates to. The
 * section pages read the param back out through `useDeepLinkHighlight`, which
 * is what scrolls the row into view and flashes it.
 */
export function settingsSearchTargetRoute(target: SettingsSearchTarget): string {
  const params = new URLSearchParams()

  if (target.field) {
    params.set('field', target.field)
  }

  if (target.key) {
    params.set('key', target.key)
  }

  if (target.setting) {
    params.set('setting', target.setting)
  }

  const query = params.toString()

  return `/settings/${target.view}${query ? `?${query}` : ''}`
}

/**
 * Which Keys sub-tab an env var belongs to, or `null` when it must not be
 * searchable at all: `channel_managed` vars are owned by the richer Messaging
 * page, and provider LLM keys (any other category) are owned by the Providers
 * page — surfacing either here would deep-link to a card the Keys page hides.
 * Mirrors `VIEW_CATEGORIES` in keys-section.tsx.
 */
export function credentialSettingsView(info: EnvVarInfo): CredentialSettingsView | null {
  if (info.channel_managed) {
    return null
  }

  if (info.category === 'tool') {
    return 'tools'
  }

  return info.category === 'setting' || info.category === 'messaging' ? 'settings' : null
}

/**
 * One entry per config field the Settings UI actually renders. Reuses
 * `sectionFieldEntries` (schema ?? FALLBACK_FIELD_SCHEMA ?? inferred-from-value,
 * per MJXHRM-443) so search can never offer a row the page then drops, and
 * `voiceFieldVisible` so the Voice page's provider-filtered fields match too.
 */
export function buildConfigSearchEntries(
  schema: null | Record<string, ConfigFieldSchema> | undefined,
  config: HermesConfigRecord | null | undefined,
  copy: {
    fieldDescriptions: Record<string, string>
    fieldLabels: Record<string, string>
    sections: Record<string, string>
  },
  sections: DesktopConfigSection[] = SECTIONS
): SettingsSearchEntry[] {
  if (!schema || !config) {
    return []
  }

  const bySection = sectionFieldEntries(schema, config)

  return sections.flatMap(section => {
    const context = copy.sections[section.id] ?? section.label

    return (bySection.get(section.id) ?? [])
      .filter(([key]) => section.id !== 'voice' || voiceFieldVisible(key, config))
      .map(([key]) => ({
        context,
        description: fieldCopyForSchemaKey(copy.fieldDescriptions, key),
        icon: section.icon as IconComponent,
        id: `config-field:${key}`,
        keywords: [key, section.label, ...key.split('.')],
        label: fieldCopyForSchemaKey(copy.fieldLabels, key) ?? prettyName(key.split('.').pop() ?? key),
        target: { field: key, view: section.id }
      }))
  })
}

/** One entry per searchable credential env var, homed on its Keys sub-tab. */
export function buildCredentialSearchEntries(
  vars: null | Record<string, EnvVarInfo> | undefined,
  copy: { settings: string; tools: string }
): SettingsSearchEntry[] {
  if (!vars) {
    return []
  }

  return Object.entries(vars).flatMap(([key, info]) => {
    const view = credentialSettingsView(info)

    if (!view) {
      return []
    }

    return [
      {
        context: view === 'tools' ? copy.tools : copy.settings,
        description: info.description,
        icon: KeyRound,
        id: `credential:${key}`,
        keywords: [key, 'credential', 'api key', 'secret', 'token', ...(info.url ? [info.url] : []), ...info.tools],
        label: credentialRowLabel(key, info),
        target: { key, view: view === 'tools' ? 'keys' : 'keys/settings' }
      }
    ]
  })
}

/**
 * One entry per device-local row from `CLIENT_PREF_SETTINGS`. Desktop-only rows
 * are dropped on mobile so a result can never land on a row that never renders
 * (the deep-link would poll for a DOM id that is not coming).
 */
export function buildClientPrefSearchEntries(
  t: Translations,
  sectionLabels: Record<string, string>
): SettingsSearchEntry[] {
  return CLIENT_PREF_SETTINGS.filter(pref => IS_DESKTOP || !pref.desktopOnly).map(pref => ({
    context: sectionLabels[pref.view] ?? pref.view,
    icon: Settings2,
    id: `setting:${pref.id}`,
    keywords: [...pref.keywords, pref.id],
    label: pref.label(t),
    target: { setting: pref.id, view: pref.view }
  }))
}
