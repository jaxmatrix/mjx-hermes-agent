import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const UI = path.join(import.meta.dirname, '.')

/**
 * The in-app browser's guest is a NATIVE view the compositor paints above the
 * whole DOM (MJXHRM-447), so a portalled Radix surface renders BEHIND it unless
 * something hides the guest first.
 *
 * Universal's `components/ui/` and `app/overlays/` are desktop's files, verbatim
 * — desktop draws its page in a `<webview>` and needs no per-primitive claim.
 * Occlusion is read off what those components render (`watchGuestOccluders` in
 * `store/browser-occlusion.ts`); see `browser-occlusion.test.ts` for behavior.
 */
describe('portalled primitives claim guest occlusion', () => {
  it('watches the DOM for occluders instead of wiring each ui primitive', () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, '../../store/browser-occlusion.ts'), 'utf8')

    expect(source).toContain('watchGuestOccluders')
    expect(source).toContain('OCCLUDER_SELECTOR')
    expect(source).toContain('data-overlay-surface')
  })

  it('the list is not vacuous — every named ui shell file exists', () => {
    const claimants = ['context-menu.tsx', 'dialog.tsx', 'dropdown-menu.tsx', 'popover.tsx', 'select.tsx']

    for (const file of claimants) {
      expect(fs.existsSync(path.join(UI, file)), file).toBe(true)
    }
  })
})
