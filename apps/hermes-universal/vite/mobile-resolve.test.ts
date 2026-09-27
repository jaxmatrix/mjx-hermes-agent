import { describe, expect, it } from 'vitest'

import { resolveMobileTwin, shouldEnableMobileResolve } from './mobile-resolve'

describe('shouldEnableMobileResolve', () => {
  it('is on for android and ios Tauri platforms', () => {
    expect(shouldEnableMobileResolve({ TAURI_ENV_PLATFORM: 'android' })).toBe(true)
    expect(shouldEnableMobileResolve({ TAURI_ENV_PLATFORM: 'ios' })).toBe(true)
    expect(shouldEnableMobileResolve({ TAURI_PLATFORM: 'android' })).toBe(true)
  })

  it('is on when HERMES_MOBILE_RESOLVE is set', () => {
    expect(shouldEnableMobileResolve({ HERMES_MOBILE_RESOLVE: '1' })).toBe(true)
    expect(shouldEnableMobileResolve({ HERMES_MOBILE_RESOLVE: 'true' })).toBe(true)
  })

  it('is off for desktop builds', () => {
    expect(shouldEnableMobileResolve({ TAURI_ENV_PLATFORM: 'linux' })).toBe(false)
    expect(shouldEnableMobileResolve({ TAURI_ENV_PLATFORM: 'macos' })).toBe(false)
    expect(shouldEnableMobileResolve({})).toBe(false)
  })
})

describe('resolveMobileTwin', () => {
  const exists = (p: string) => p.endsWith('sessions-window.mobile.tsx')

  it('prefers Foo.mobile.tsx when the twin exists', () => {
    expect(resolveMobileTwin('/app/shell/sessions-window.tsx', exists)).toBe(
      '/app/shell/sessions-window.mobile.tsx'
    )
  })

  it('falls back when no twin exists', () => {
    expect(resolveMobileTwin('/app/chat/sidebar/index.tsx', exists)).toBeNull()
  })

  it('does not rewrite an already-mobile path', () => {
    expect(resolveMobileTwin('/app/shell/sessions-window.mobile.tsx', () => true)).toBeNull()
  })

  it('preserves query strings on the twin', () => {
    expect(resolveMobileTwin('/app/shell/sessions-window.tsx?v=1', exists)).toBe(
      '/app/shell/sessions-window.mobile.tsx?v=1'
    )
  })
})
