import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { deleteUserPreset, saveLayoutPresetTree } from '@/components/pane-shell/tree/presets'
import { LayoutPicker } from '@/components/pane-shell/tree/renderer/layout-picker'
import { I18nProvider } from '@/i18n'

/**
 * Deleting a saved layout preset, on a finger.
 *
 * The edit palette's card ✕ is an `opacity-0` reveal, so on a coarse pointer it
 * never appeared and a preset saved on a phone or tablet could never be removed.
 * That is the same shape as MJXHRM-377 and the panel row menu next door: the
 * hidden element is the ONLY path to the action, which is exactly when the
 * house rule in styles.css requires the `coarse:` companion.
 */
const PRESET = 'Trial layout'

let presetId: null | string = null

function seedPreset() {
  presetId = saveLayoutPresetTree(PRESET, { active: 'workspace', id: 'g', panes: ['workspace'], type: 'group' })
}

afterEach(() => {
  cleanup()

  if (presetId) {
    deleteUserPreset(presetId)
    presetId = null
  }
})

describe('deleting a user layout preset', () => {
  it('keeps the picker card ✕ visible on a coarse pointer', () => {
    seedPreset()

    render(
      <I18nProvider>
        <LayoutPicker />
      </I18nProvider>
    )

    const classes = screen.getByRole('button', { name: `Delete ${PRESET}` }).className.split(/\s+/)

    expect(classes).toContain('opacity-0')
    expect(classes).toContain('coarse:opacity-100')
  })
})
