import { afterEach, describe, expect, it } from 'vitest'

import { $dirtyPreviewPaths, setPreviewDirty } from './preview-edit'

afterEach(() => $dirtyPreviewPaths.set(new Set()))

describe('preview dirty tracking', () => {
  it('adds and removes dirty paths', () => {
    setPreviewDirty('/a', true)
    expect($dirtyPreviewPaths.get().has('/a')).toBe(true)
    setPreviewDirty('/a', false)
    expect($dirtyPreviewPaths.get().has('/a')).toBe(false)
  })

  it('is a no-op (keeps the same Set reference) when unchanged', () => {
    const before = $dirtyPreviewPaths.get()
    setPreviewDirty('/a', false)
    expect($dirtyPreviewPaths.get()).toBe(before)
  })
})
