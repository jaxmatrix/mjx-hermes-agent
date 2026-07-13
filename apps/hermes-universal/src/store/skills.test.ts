import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SkillInfo, ToolsetInfo } from '@/types/hermes'

const skill = (over: Partial<SkillInfo>): SkillInfo => ({ name: 's', description: '', category: '', enabled: false, ...over })
const toolset = (over: Partial<ToolsetInfo>): ToolsetInfo => ({ name: 't', label: 't', description: '', configured: false, enabled: false, tools: [], ...over })

vi.mock('@/hermes', () => ({
  getSkills: vi.fn(async () => [skill({ name: 'grep', enabled: true }), skill({ name: 'todo' })]),
  getToolsets: vi.fn(async () => [toolset({ name: 'browser', enabled: true })]),
  toggleSkill: vi.fn(async () => ({ ok: true, name: 'x', enabled: false })),
  toggleToolset: vi.fn(async () => ({ ok: true, name: 'x', enabled: false }))
}))

import { toggleSkill } from '@/hermes'

import { $skills, $toolsets, refreshCapabilities, setSkillEnabled } from './skills'

const toggle = vi.mocked(toggleSkill)

describe('skills store', () => {
  beforeEach(() => {
    toggle.mockClear()
    $skills.set([])
    $toolsets.set([])
  })
  afterEach(() => {
    $skills.set([])
    $toolsets.set([])
  })

  it('loads skills + toolsets', async () => {
    await refreshCapabilities()
    expect($skills.get().map(s => s.name)).toEqual(['grep', 'todo'])
    expect($toolsets.get().map(t => t.name)).toEqual(['browser'])
  })

  it('disables a skill optimistically', async () => {
    await refreshCapabilities()
    await setSkillEnabled('grep', false)
    expect(toggle).toHaveBeenCalledWith('grep', false)
    expect($skills.get().find(s => s.name === 'grep')?.enabled).toBe(false)
  })
})
