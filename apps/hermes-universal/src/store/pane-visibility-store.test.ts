import { beforeEach, describe, expect, it } from 'vitest'

import { $paneVisible, __resetPaneVisibility, forgetPaneVisibility, setPaneVisible } from './pane-visibility-store'

beforeEach(__resetPaneVisibility)

describe('$paneVisible', () => {
  // A caller should not have to tell "hidden" from "I have never heard of it".
  it('reads false for a pane nobody has published', () => {
    expect($paneVisible('never-mounted').get()).toBe(false)
  })

  it('returns the SAME atom per id, so a subscriber survives a remount', () => {
    const first = $paneVisible('workspace')
    setPaneVisible('workspace', true)

    expect($paneVisible('workspace')).toBe(first)
    expect(first.get()).toBe(true)
  })

  it('notifies subscribers on a change and not on a repeat', () => {
    const seen: boolean[] = []
    $paneVisible('workspace').subscribe(value => seen.push(value))

    setPaneVisible('workspace', true)
    setPaneVisible('workspace', true)
    setPaneVisible('workspace', false)

    // The immediate `subscribe` call, then one per real change.
    expect(seen).toEqual([false, true, false])
  })

  it('keeps panes apart', () => {
    setPaneVisible('a', true)

    expect($paneVisible('b').get()).toBe(false)
  })

  // Reported as hidden rather than dropped: a plugin holding the atom has to SEE
  // the pane go away, not be left subscribed to a value that stopped moving.
  it('turns a forgotten pane false in place', () => {
    const pane = $paneVisible('a')
    setPaneVisible('a', true)

    const seen: boolean[] = []
    pane.subscribe(value => seen.push(value))
    forgetPaneVisibility('a')

    expect(seen).toEqual([true, false])
    expect(pane.get()).toBe(false)
  })
})
