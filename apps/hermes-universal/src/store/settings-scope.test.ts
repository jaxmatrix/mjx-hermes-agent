import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/hermes', () => ({ getProfiles: vi.fn(async () => ({ profiles: [] })), setApiRequestProfile: vi.fn() }))
vi.mock('@/lib/query-client', () => ({ invalidateProfileScopedQueries: vi.fn() }))
vi.mock('@/lib/slash-completion-cache', () => ({ invalidateSlashCompletions: vi.fn() }))

import { $activeProfile } from '@/store/profiles'
import { $settingsScopeOverride, $settingsScopeProfile, setSettingsScope } from '@/store/settings-scope'

beforeEach(() => {
  $activeProfile.set(null)
  $settingsScopeOverride.set(null)
})

describe('settings scope', () => {
  // `null` is not "no profile" — it is "follow the app", which is what keeps
  // single-profile users on the unscoped request shape.
  it('resolves to the app profile with no override', () => {
    expect($settingsScopeProfile.get()).toBe('default')

    $activeProfile.set('research')
    expect($settingsScopeProfile.get()).toBe('research')
  })

  it('stores an override for another profile', () => {
    setSettingsScope('research')

    expect($settingsScopeOverride.get()).toBe('research')
    expect($settingsScopeProfile.get()).toBe('research')
  })

  // Picking the profile the app is ALREADY on must clear the override, not pin
  // it: a pinned "default" would keep sending ?profile=default forever and
  // would stop following the app on the next switch.
  it('clears the override when the app profile itself is picked', () => {
    $activeProfile.set('research')
    setSettingsScope('default')
    expect($settingsScopeOverride.get()).toBe('default')

    setSettingsScope('research')
    expect($settingsScopeOverride.get()).toBeNull()
  })

  // An app-wide switch re-homes every settings surface; a surviving override
  // would silently keep the next save pointed at the profile you just left.
  it('drops a surviving override when the app switches profile', () => {
    setSettingsScope('research')
    expect($settingsScopeOverride.get()).toBe('research')

    $activeProfile.set('work')

    expect($settingsScopeOverride.get()).toBeNull()
    expect($settingsScopeProfile.get()).toBe('work')
  })
})
