import { describe, expect, it, vi } from 'vitest'

import { Wrench } from '@/lib/icons'
import type { ConfigFieldSchema, EnvVarInfo } from '@/types/hermes'

import {
  buildClientPrefSearchEntries,
  buildConfigSearchEntries,
  buildCredentialSearchEntries,
  CLIENT_PREF_SETTINGS,
  credentialSettingsView,
  settingsSearchTargetRoute
} from './settings-search'
import type { DesktopConfigSection } from './types'

const copy = {
  fieldDescriptions: { 'timeouts.tools.sequentialCall': 'How long one tool may run' },
  fieldLabels: { 'timeouts.tools.sequentialCall': 'Sequential tool timeout' },
  sections: { advanced: 'Advanced (translated)', voice: 'Voice (translated)' }
}

const envVar = (over: Partial<EnvVarInfo>): EnvVarInfo => ({
  advanced: false,
  category: 'tool',
  description: '',
  is_password: true,
  is_set: false,
  redacted_value: null,
  tools: [],
  url: null,
  ...over
})

describe('settingsSearchTargetRoute', () => {
  it('serialises each target kind onto its section path', () => {
    expect(settingsSearchTargetRoute({ field: 'agent.max_turns', view: 'advanced' })).toBe(
      '/settings/advanced?field=agent.max_turns'
    )
    expect(settingsSearchTargetRoute({ key: 'BRAVE_API_KEY', view: 'keys' })).toBe('/settings/keys?key=BRAVE_API_KEY')
    expect(settingsSearchTargetRoute({ setting: 'appearance.intro-splash', view: 'appearance' })).toBe(
      '/settings/appearance?setting=appearance.intro-splash'
    )
    expect(settingsSearchTargetRoute({ view: 'billing' })).toBe('/settings/billing')
  })

  it('percent-encodes a value that would otherwise break the query', () => {
    expect(settingsSearchTargetRoute({ key: 'A B&C=D', view: 'keys/settings' })).toBe(
      '/settings/keys/settings?key=A+B%26C%3DD'
    )
  })
})

describe('buildConfigSearchEntries', () => {
  // The fixture DISAGREES with the expectation on purpose: the schema is empty
  // and the config holds no value at that path, so the entry can only exist if
  // FALLBACK_FIELD_SCHEMA (MJXHRM-443) carried it through sectionFieldEntries.
  it('keeps a field the backend schema omits but FALLBACK_FIELD_SCHEMA declares', () => {
    const entries = buildConfigSearchEntries({}, {}, copy)
    const fallbackEntry = entries.find(entry => entry.id === 'config-field:timeouts.tools.sequential_call')

    expect(fallbackEntry).toBeDefined()
    expect(fallbackEntry?.label).toBe('Sequential tool timeout')
    expect(fallbackEntry?.description).toBe('How long one tool may run')
    expect(fallbackEntry?.context).toBe('Advanced (translated)')
    expect(fallbackEntry?.target).toEqual({ field: 'timeouts.tools.sequential_call', view: 'advanced' })

    // A key that is in no schema, no fallback and no config must NOT appear —
    // otherwise the assertion above would pass for the wrong reason.
    expect(entries.some(entry => entry.id === 'config-field:agent.max_turns')).toBe(false)
  })

  it('falls back to a prettified leaf name when no label copy exists', () => {
    const sections: DesktopConfigSection[] = [
      { icon: Wrench, id: 'advanced', keys: ['agent.max_turns'], label: 'Advanced' }
    ]

    const [entry] = buildConfigSearchEntries({ 'agent.max_turns': { type: 'number' } }, {}, copy, sections)

    expect(entry.label).toBe('Max Turns')
    expect(entry.keywords).toContain('agent.max_turns')
    expect(entry.keywords).toContain('max_turns')
  })

  // Seeded with tts.provider = openai, so an ElevenLabs voice field is a row
  // the Voice page will not render — search must not offer it.
  it('drops voice fields belonging to an inactive provider', () => {
    const schema: Record<string, ConfigFieldSchema> = {
      'tts.elevenlabs.voice_id': { type: 'string' },
      'tts.openai.voice': { type: 'string' }
    }

    const entries = buildConfigSearchEntries(schema, { tts: { provider: 'openai' } }, copy)
    const ids = entries.map(entry => entry.id)

    expect(ids).toContain('config-field:tts.openai.voice')
    expect(ids).not.toContain('config-field:tts.elevenlabs.voice_id')
  })

  it('returns nothing until both the schema and the config have loaded', () => {
    expect(buildConfigSearchEntries(null, {}, copy)).toEqual([])
    expect(buildConfigSearchEntries({}, null, copy)).toEqual([])
  })
})

describe('credentialSettingsView', () => {
  it('routes each category to the sub-tab the Keys page renders it on', () => {
    expect(credentialSettingsView(envVar({ category: 'tool' }))).toBe('tools')
    expect(credentialSettingsView(envVar({ category: 'setting' }))).toBe('settings')
    expect(credentialSettingsView(envVar({ category: 'messaging' }))).toBe('settings')
  })

  it('excludes vars no Keys sub-tab shows', () => {
    // channel_managed: owned by the Messaging page even though the category matches.
    expect(credentialSettingsView(envVar({ category: 'messaging', channel_managed: true }))).toBeNull()
    // provider LLM keys: owned by the Providers page.
    expect(credentialSettingsView(envVar({ category: 'provider' }))).toBeNull()
  })
})

describe('buildCredentialSearchEntries', () => {
  it('builds one entry per searchable var and skips the rest', () => {
    const entries = buildCredentialSearchEntries(
      {
        ANTHROPIC_API_KEY: envVar({ category: 'provider' }),
        BRAVE_API_KEY: envVar({ category: 'tool', tools: ['web_search'], url: 'https://brave.com/keys' }),
        GATEWAY_PROXY: envVar({ category: 'setting', description: 'Outbound proxy' }),
        SLACK_BOT_TOKEN: envVar({ category: 'messaging', channel_managed: true })
      },
      { settings: 'Gateway settings', tools: 'Tool keys' }
    )

    expect(entries.map(entry => entry.id)).toEqual(['credential:BRAVE_API_KEY', 'credential:GATEWAY_PROXY'])

    const brave = entries[0]

    // credentialRowLabel strips the _API_KEY suffix — a plain key echo would not.
    expect(brave.label).toBe('BRAVE')
    expect(brave.context).toBe('Tool keys')
    expect(brave.keywords).toContain('web_search')
    expect(brave.keywords).toContain('https://brave.com/keys')
    expect(brave.target).toEqual({ key: 'BRAVE_API_KEY', view: 'keys' })

    expect(entries[1].context).toBe('Gateway settings')
    expect(entries[1].target).toEqual({ key: 'GATEWAY_PROXY', view: 'keys/settings' })
  })

  it('returns nothing before the env map loads', () => {
    expect(buildCredentialSearchEntries(undefined, { settings: 's', tools: 't' })).toEqual([])
  })
})

describe('buildClientPrefSearchEntries', () => {
  // MJXHRM-489: these six rows were unfindable because they carry no config key.
  const t = {
    language: { label: 'Language' },
    quickEntry: { settingsTitle: 'Quick Entry' },
    settings: {
      appearance: {
        backdropTitle: 'Chat Backdrop',
        embedsTitle: 'Inline Embeds',
        introSplashTitle: 'Intro Splash',
        reactionsTitle: 'Message Reactions',
        resizeCalmTitle: 'Settle Before Showing',
        resizeRateTitle: 'Resize Smoothness',
        terminalFontTitle: 'Terminal Font',
        themeTitle: 'Theme',
        toolViewTitle: 'Tool Call Display',
        translucencyTitle: 'Window Translucency',
        uiScaleTitle: 'UI Scale'
      },
      config: {
        attachmentSizeTitle: 'Max attachment / preview size',
        backgroundModeTitle: 'Keep running in the background',
        keepAwakeTitle: 'Keep computer awake'
      },
      workspace: { terminalHostTitle: 'Shell runs on' }
    }
  } as any

  it('covers every row MJXHRM-489 listed, homed on the page that renders it', () => {
    const entries = buildClientPrefSearchEntries(t, { advanced: 'Advanced', appearance: 'Appearance', chat: 'Chat' })
    const byId = new Map(entries.map(entry => [entry.id, entry]))

    expect(byId.get('setting:appearance.intro-splash')?.label).toBe('Intro Splash')
    expect(byId.get('setting:appearance.backdrop')?.label).toBe('Chat Backdrop')
    expect(byId.get('setting:appearance.tool-view')?.label).toBe('Tool Call Display')
    expect(byId.get('setting:appearance.embeds')?.label).toBe('Inline Embeds')
    expect(byId.get('setting:chat.attachment-size')?.label).toBe('Max attachment / preview size')

    // The row's home page, not a generic "Settings" bucket.
    expect(byId.get('setting:chat.attachment-size')?.context).toBe('Chat')
    expect(byId.get('setting:appearance.intro-splash')?.target).toEqual({
      setting: 'appearance.intro-splash',
      view: 'appearance'
    })
  })

  // jsdom has no Tauri runtime, so the module-level IS_DESKTOP is false here —
  // which is exactly the mobile case. Both directions are mocked explicitly so
  // neither assertion rides on the test environment's own platform verdict.
  it('hides desktop-only rows where the row itself never renders', async () => {
    vi.resetModules()
    vi.doMock('@/lib/platform', () => ({ IS_DESKTOP: false, IS_MOBILE: true, IS_TAURI: false }))

    const mobile = await import('./settings-search')
    const ids = mobile.buildClientPrefSearchEntries(t, {}).map(entry => entry.id)

    expect(ids).not.toContain('setting:advanced.keep-awake')
    expect(ids).not.toContain('setting:appearance.translucency')
    // Non-gated rows survive — proving the filter, not an empty result.
    expect(ids).toContain('setting:appearance.intro-splash')

    vi.doUnmock('@/lib/platform')
    vi.resetModules()
  })

  it('lists the desktop-only rows on desktop', async () => {
    vi.resetModules()
    vi.doMock('@/lib/platform', () => ({ IS_DESKTOP: true, IS_MOBILE: false, IS_TAURI: true }))

    const desktop = await import('./settings-search')
    const entries = desktop.buildClientPrefSearchEntries(t, { advanced: 'Advanced' })
    const byId = new Map(entries.map(entry => [entry.id, entry]))

    expect(byId.get('setting:advanced.keep-awake')?.label).toBe('Keep computer awake')
    expect(byId.get('setting:advanced.keep-awake')?.context).toBe('Advanced')
    expect(byId.get('setting:advanced.background-mode')?.label).toBe('Keep running in the background')
    expect(byId.get('setting:advanced.quick-entry')?.label).toBe('Quick Entry')
    expect(byId.get('setting:appearance.translucency')?.label).toBe('Window Translucency')

    vi.doUnmock('@/lib/platform')
    vi.resetModules()
  })

  it('gives every declared row a unique id and a section it can route to', () => {
    const ids = CLIENT_PREF_SETTINGS.map(pref => pref.id)

    expect(new Set(ids).size).toBe(ids.length)
    expect(CLIENT_PREF_SETTINGS.every(pref => pref.view.length > 0)).toBe(true)
  })
})
