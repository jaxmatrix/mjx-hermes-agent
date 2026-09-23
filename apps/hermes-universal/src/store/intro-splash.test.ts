import { describe, expect, it } from 'vitest'

import { $introSplash, setIntroSplash } from './intro-splash'

describe('$introSplash', () => {
  it('defaults ON, matching desktop', () => {
    // Nothing had written the key when this module loaded, so this IS the
    // fallback a first-run device sees — `persistentAtom` then writes it back
    // (its subscribe fires with the initial value). Desktop ships the splash on;
    // a port that quietly shipped it off would look like a dropped feature.
    expect($introSplash.get()).toBe(true)
    expect(window.localStorage.getItem('hermes.introSplash')).toBe('true')
  })

  it('persists the user turning it off', () => {
    setIntroSplash(false)

    expect($introSplash.get()).toBe(false)
    expect(window.localStorage.getItem('hermes.introSplash')).toBe('false')
  })
})
