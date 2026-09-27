import { describe, expect, it } from 'vitest'

import { SECTIONS } from './constants'
import { defaultSectionForNavGroup, navGroupToSettingsView, settingsSubpageSegment } from './nav-group-section'
import { settingsSubpages } from './subpages'

describe('navGroupToSettingsView', () => {
  it('maps shortcuts to keybinds and gateway to itself', () => {
    expect(navGroupToSettingsView('shortcuts')).toBe('keybinds')
    expect(navGroupToSettingsView('gateway')).toBe('gateway')
    expect(navGroupToSettingsView('notifications')).toBe('notifications')
  })

  it('maps schema config sections to config: ids', () => {
    const first = SECTIONS[0]?.id
    expect(first).toBeTruthy()
    expect(navGroupToSettingsView(first!)).toBe(`config:${first}`)
  })
})

describe('defaultSectionForNavGroup', () => {
  it('uses the first nav child when present', () => {
    expect(
      defaultSectionForNavGroup({
        id: 'providers',
        children: [{ id: 'providers' }, { id: 'providers/keys' }]
      })
    ).toBe('providers')
  })

  it('uses the first settingsSubpage for gateway', () => {
    const pages = settingsSubpages('gateway')
    expect(pages.length).toBeGreaterThan(1)
    expect(defaultSectionForNavGroup({ id: 'gateway' })).toBe(`gateway/${pages[0]!.id}`)
    expect(defaultSectionForNavGroup({ id: 'gateway' })).toBe('gateway/connection')
  })

  it('uses the first CONFIG / APPEARANCE subpage for schema groups', () => {
    const appearance = settingsSubpages('config:appearance')
    expect(appearance.length).toBeGreaterThan(1)
    expect(defaultSectionForNavGroup({ id: 'appearance' })).toBe(`appearance/${appearance[0]!.id}`)

    const model = settingsSubpages('config:model')
    expect(model.length).toBeGreaterThan(1)
    expect(defaultSectionForNavGroup({ id: 'model' })).toBe(`model/${model[0]!.id}`)
  })
})

describe('settingsSubpageSegment', () => {
  it('returns the path after the group id', () => {
    expect(settingsSubpageSegment('gateway')).toBeUndefined()
    expect(settingsSubpageSegment('gateway/connection')).toBe('connection')
    expect(settingsSubpageSegment('gateway/managed-updates')).toBe('managed-updates')
  })
})
