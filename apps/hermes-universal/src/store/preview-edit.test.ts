import { afterEach, describe, expect, it } from 'vitest'

import { $dirtyPreviewUrls, setPreviewDirty } from './preview-edit'

afterEach(() => $dirtyPreviewUrls.set({}))

describe('preview dirty tracking', () => {
  it('adds and removes dirty paths', () => {
    setPreviewDirty('/a', true)
    expect($dirtyPreviewUrls.get()['/a']).toBe(true)
    setPreviewDirty('/a', false)
    expect($dirtyPreviewUrls.get()['/a']).toBeUndefined()
  })

  it('is a no-op (keeps the same Set reference) when unchanged', () => {
    const before = $dirtyPreviewUrls.get()
    setPreviewDirty('/a', false)
    expect($dirtyPreviewUrls.get()).toBe(before)
  })
})
