import { afterEach, describe, expect, it } from 'vitest'

import {
  $activePreviewPath,
  $activePreviewTarget,
  $previewTabs,
  closeAllPreviewTabs,
  closeOtherPreviewTabs,
  closePreviewTab,
  setPreviewTarget
} from './preview'

afterEach(() => closeAllPreviewTabs())

describe('preview tabs store', () => {
  it('opens a tab (basename label) and makes it active', () => {
    setPreviewTarget('/repo/src/app.ts')
    expect($previewTabs.get()).toEqual([{ name: 'app.ts', path: '/repo/src/app.ts' }])
    expect($activePreviewPath.get()).toBe('/repo/src/app.ts')
    expect($activePreviewTarget.get()?.name).toBe('app.ts')
  })

  it('re-activates an already-open tab instead of duplicating it', () => {
    setPreviewTarget('/a.ts')
    setPreviewTarget('/b.ts')
    setPreviewTarget('/a.ts')
    expect($previewTabs.get().map(t => t.path)).toEqual(['/a.ts', '/b.ts'])
    expect($activePreviewPath.get()).toBe('/a.ts')
  })

  it('closing the active tab falls back to the last remaining, then null', () => {
    setPreviewTarget('/a.ts')
    setPreviewTarget('/b.ts')
    closePreviewTab('/b.ts')
    expect($activePreviewPath.get()).toBe('/a.ts')
    closePreviewTab('/a.ts')
    expect($activePreviewPath.get()).toBeNull()
  })

  it('closeOthers keeps only the given tab; closeAll clears everything', () => {
    setPreviewTarget('/a.ts')
    setPreviewTarget('/b.ts')
    setPreviewTarget('/c.ts')
    closeOtherPreviewTabs('/b.ts')
    expect($previewTabs.get().map(t => t.path)).toEqual(['/b.ts'])
    expect($activePreviewPath.get()).toBe('/b.ts')
    closeAllPreviewTabs()
    expect($previewTabs.get()).toEqual([])
    expect($activePreviewPath.get()).toBeNull()
  })
})
