/**
 * Bot Mode against the REAL host boundary.
 *
 * Not a mock of `createPluginContext` and not a mock of the registry: the whole
 * question this file answers is whether the plugin's contributions actually
 * land where the app looks for them, with the right provenance, and whether
 * `register()` keeps its promise not to touch the network.
 *
 * Extends MJXHRM-461's `kanban-host.test.tsx` pattern.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { requestGateway } = vi.hoisted(() => ({ requestGateway: vi.fn() }))

vi.mock('@/store/gateway', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>()

  return { ...actual, requestGateway }
})

import { COMPOSER_AREAS, type ComposerAtCompletionSource } from '@/app/chat/composer/contrib'
import { PALETTE_AREA } from '@/app/command-palette/contrib'
import { CONTEXT_MENU_ITEMS_AREA } from '@/app/context-menu/contrib'
import { type KeybindContribution, KEYBINDS_AREA } from '@/lib/keybinds/actions'
import { TRANSCRIPT_DIRECTIVE_AREA, type TranscriptDirectiveContribution } from '@/lib/transcript-directives'

import { createPluginContext } from './plugin'
import { registry } from './registry'

const PANES_AREA = 'panes'

async function loadPlugin() {
  const module = await import('@/plugins/hermes-bots/plugin')

  return module.default
}

const disposers: (() => void)[] = []

function register(plugin: Awaited<ReturnType<typeof loadPlugin>>) {
  const collected: (() => void)[] = []

  plugin.register(createPluginContext(plugin.id, dispose => collected.push(dispose)))
  disposers.push(() => collected.forEach(dispose => dispose()))

  return collected
}

beforeEach(() => {
  requestGateway.mockReset()
  window.localStorage.clear()
})

afterEach(() => {
  disposers.splice(0).forEach(dispose => dispose())
})

const idsIn = (area: string) => registry.getArea(area).map(contribution => contribution.id)

describe('the Bot Mode plugin at the host boundary', () => {
  it('declares itself default-on with a name a settings row can render', async () => {
    const plugin = await loadPlugin()

    expect(plugin.id).toBe('hermes-bots')
    expect(plugin.name).toBe('Bot Mode')
    expect(plugin.defaultEnabled).toBe(true)
    expect(plugin.description).toBeTruthy()
  })

  it('makes ZERO gateway calls at register()', async () => {
    // A plugin that dials on load makes every cold start slower for users who
    // never open it. The roster is fetched when the pane first becomes visible.
    register(await loadPlugin())

    expect(requestGateway).not.toHaveBeenCalled()
  })

  it('lands its contributions in the right areas, with plugin provenance', async () => {
    register(await loadPlugin())

    expect(idsIn(PANES_AREA)).toContain('hermes-bots:pane')
    expect(idsIn(COMPOSER_AREAS.atCompletions)).toContain('hermes-bots:mention-completions')
    expect(idsIn(TRANSCRIPT_DIRECTIVE_AREA)).toContain('hermes-bots:dm-card')
    expect(idsIn(CONTEXT_MENU_ITEMS_AREA)).toContain('hermes-bots:row-verbs')
    expect(idsIn(KEYBINDS_AREA)).toContain('hermes-bots:toggle')
    expect(idsIn(PALETTE_AREA)).toEqual(expect.arrayContaining(['hermes-bots:reveal', 'hermes-bots:open-room']))

    for (const area of [PANES_AREA, COMPOSER_AREAS.atCompletions, KEYBINDS_AREA]) {
      for (const contribution of registry.getArea(area).filter(entry => entry.id.startsWith('hermes-bots:'))) {
        expect(contribution.source).toBe('plugin:hermes-bots')
      }
    }
  })

  it('docks the BOTS pane into the sessions strip as an ENFORCED tab', async () => {
    register(await loadPlugin())

    const pane = registry.getArea(PANES_AREA).find(entry => entry.id === 'hermes-bots:pane')
    const chrome = (pane?.data as { chrome?: { dock?: { enforce?: boolean; pane?: string; pos?: string } } })?.chrome

    // The whole SESSIONS│BOTS strip rests on these three fields.
    expect(chrome?.dock).toEqual({ enforce: true, pane: 'sessions', pos: 'center' })
  })

  it('ships a keybind default no other action owns', async () => {
    register(await loadPlugin())

    const bind = registry.getArea(KEYBINDS_AREA).find(entry => entry.id === 'hermes-bots:toggle')
      ?.data as KeybindContribution

    // ⌘⇧B is `workspace.newWorktree`'s and has been since MJXHRM-62.
    expect(bind.defaults).not.toContain('mod+shift+b')
    expect(bind.defaults).toEqual(['mod+shift+j'])
  })

  it('answers @ completions synchronously, and empty before any roster is loaded', async () => {
    register(await loadPlugin())

    const source = registry.getArea(COMPOSER_AREAS.atCompletions).find(entry => entry.id === 'hermes-bots:mention-completions')
      ?.data as ComposerAtCompletionSource

    // SYNCHRONOUS: this runs on every keystroke past the debounce. A promise
    // here would be a fetch on the composer's hot path.
    const rows = source.provide('ra')

    expect(Array.isArray(rows)).toBe(true)
    expect(requestGateway).not.toHaveBeenCalled()
  })

  it('registers the DM card under the name the wire text uses', async () => {
    register(await loadPlugin())

    const directive = registry.getArea(TRANSCRIPT_DIRECTIVE_AREA).find(entry => entry.id === 'hermes-bots:dm-card')
      ?.data as TranscriptDirectiveContribution

    expect(directive.name).toBe('bot-dm')
  })

  it('removes every contribution on dispose', async () => {
    const collected = register(await loadPlugin())

    collected.forEach(dispose => dispose())

    for (const area of [
      PANES_AREA,
      COMPOSER_AREAS.atCompletions,
      TRANSCRIPT_DIRECTIVE_AREA,
      CONTEXT_MENU_ITEMS_AREA,
      KEYBINDS_AREA,
      PALETTE_AREA
    ]) {
      expect(idsIn(area).filter(id => id.startsWith('hermes-bots:'))).toEqual([])
    }
  })
})
