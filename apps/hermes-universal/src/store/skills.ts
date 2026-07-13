import { getSkills, getToolsets, toggleSkill, toggleToolset } from '@/hermes'
import { atom } from '@/store/atom'
import { notifyError } from '@/store/notifications'
import type { SkillInfo, ToolsetInfo } from '@/types/hermes'

// Capabilities store — skills + toolsets. MCP + Hub are separate (Kc7/Kc8).
export const $skills = atom<SkillInfo[]>([])
export const $toolsets = atom<ToolsetInfo[]>([])
export const $capsLoading = atom(false)
export const $capsError = atom<string | null>(null)

export async function refreshCapabilities(): Promise<void> {
  $capsLoading.set(true)
  $capsError.set(null)
  try {
    const [skills, toolsets] = await Promise.all([getSkills(), getToolsets()])
    $skills.set(skills)
    $toolsets.set(toolsets)
  } catch (err) {
    $capsError.set(err instanceof Error ? err.message : 'Capabilities failed to load')
  } finally {
    $capsLoading.set(false)
  }
}

export async function setSkillEnabled(name: string, enabled: boolean): Promise<void> {
  const prev = $skills.get()
  $skills.set(prev.map(s => (s.name === name ? { ...s, enabled } : s)))
  try {
    await toggleSkill(name, enabled)
  } catch (err) {
    $skills.set(prev)
    notifyError(err, `Failed to update ${name}`)
  }
}

export async function setToolsetEnabled(name: string, enabled: boolean): Promise<void> {
  const prev = $toolsets.get()
  $toolsets.set(prev.map(t => (t.name === name ? { ...t, enabled } : t)))
  try {
    await toggleToolset(name, enabled)
  } catch (err) {
    $toolsets.set(prev)
    notifyError(err, `Failed to update ${name}`)
  }
}
