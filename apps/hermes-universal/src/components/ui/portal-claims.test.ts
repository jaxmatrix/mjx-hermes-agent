import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const UI = path.join(import.meta.dirname, '.')

/**
 * The in-app browser's guest is a NATIVE view the compositor paints above the
 * whole DOM (MJXHRM-447), so a portalled Radix surface renders BEHIND it unless
 * something hides the guest first. There is no way to see that from a unit
 * render — the guest is a Rust-owned webview — so this pins the CALL instead.
 *
 * Deleting any one `useGuestOcclusion()` turns this red, which is the point:
 * the visible bug is a dialog opening behind a web page, and the fix is one
 * line in a file nobody would think to look at.
 */
const CLAIMANTS = ['context-menu.tsx', 'dialog.tsx', 'dropdown-menu.tsx', 'popover.tsx', 'select.tsx']

describe('portalled primitives claim guest occlusion', () => {
  for (const file of CLAIMANTS) {
    it(`${file} calls useGuestOcclusion`, () => {
      const source = fs.readFileSync(path.join(UI, file), 'utf8')

      expect(source, file).toContain("from '@/store/browser-occlusion'")
      expect(source.match(/useGuestOcclusion\('[a-z-]+'\)/), file).not.toBeNull()
    })
  }

  it('the overlay shell claims too — Settings and the palette are drawn above the pane', () => {
    const source = fs.readFileSync(path.join(UI, '../../app/overlays/overlay-view.tsx'), 'utf8')

    expect(source).toContain("useGuestOcclusion('overlay')")
  })

  it('the list is not vacuous — every named file exists', () => {
    for (const file of CLAIMANTS) {
      expect(fs.existsSync(path.join(UI, file)), file).toBe(true)
    }
  })
})
