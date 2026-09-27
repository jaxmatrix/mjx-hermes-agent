import { renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'

import { I18nProvider } from '@/i18n'

import { useSurfaceNavRows } from './surface-nav'

function wrapper(path: string) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <I18nProvider>
        <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>
      </I18nProvider>
    )
  }
}

describe('useSurfaceNavRows settings', () => {
  it('keeps unique ids so parent and first child both appear', () => {
    const { result } = renderHook(() => useSurfaceNavRows('settings'), {
      wrapper: wrapper('/settings/providers')
    })

    const ids = result.current.map(row => row.id)
    expect(new Set(ids).size).toBe(ids.length)

    expect(ids).toContain('providers:group')
    expect(ids).toContain('providers')
    expect(ids).toContain('providers/keys')
    expect(ids).toContain('providers/custom-endpoints')
    expect(ids).toContain('keys:group')
    expect(ids).toContain('keys')
    expect(ids).toContain('keys/settings')
  })

  it('marks the current child active without dropping it from the list', () => {
    const { result } = renderHook(() => useSurfaceNavRows('settings'), {
      wrapper: wrapper('/settings/providers')
    })

    const accounts = result.current.find(row => row.id === 'providers')
    const group = result.current.find(row => row.id === 'providers:group')

    expect(accounts?.active).toBe(true)
    expect(accounts?.label).toBeTruthy()
    expect(group).toBeTruthy()
  })
})
