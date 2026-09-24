/**
 * The find-in-page store: scoped DOM search (primary window path).
 *
 * Legacy tests targeted the WebKitGTK `find_in_page` invoke bridge; the store
 * now walks `[data-chat-surface]` in-process (#81726). Behaviour contracts live
 * here; FindBar wiring is in `components/find-bar.test.tsx`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  $findInPage,
  closeFindBar,
  findNext,
  findPrevious,
  openFindBar,
  setFindQuery,
  updateFindResults
} from './find-in-page'

function plantSurface(id = 'surface'): HTMLElement {
  const root = document.createElement('div')

  root.setAttribute('data-chat-surface', '')
  root.id = id
  document.body.appendChild(root)

  return root
}

beforeEach(() => {
  $findInPage.set({ active: false, query: '', matchOrdinal: 0, matchCount: 0 })
})

afterEach(() => {
  closeFindBar()
  document.body.innerHTML = ''
})

describe('find-in-page', () => {
  it('searches from scratch on a fresh query', () => {
    const surface = plantSurface()

    surface.textContent = 'hello world'
    openFindBar()
    setFindQuery('hello')

    expect($findInPage.get().query).toBe('hello')
    expect($findInPage.get().matchCount).toBe(1)
    expect(surface.querySelectorAll('mark.find-hit').length).toBe(1)
  })

  it('steps with the previous query instead of re-searching', () => {
    const surface = plantSurface()

    surface.textContent = 'hello hello hello'
    openFindBar()
    setFindQuery('hello')

    findNext()
    expect($findInPage.get().matchOrdinal).toBe(2)

    findPrevious()
    expect($findInPage.get().matchOrdinal).toBe(1)
    expect(surface.querySelectorAll('mark.find-hit').length).toBe(3)
  })

  it('counts the position itself — the engine only reports how many there are', () => {
    const surface = plantSurface()

    surface.textContent = 'hello hello hello'
    openFindBar()
    setFindQuery('hello')

    expect($findInPage.get()).toMatchObject({ matchCount: 3, matchOrdinal: 1 })

    findNext()
    expect($findInPage.get().matchOrdinal).toBe(2)

    findNext()
    findNext()
    expect($findInPage.get().matchOrdinal).toBe(1)
  })

  it('clears the highlight the moment the query empties, without waiting', () => {
    const surface = plantSurface()

    surface.textContent = 'hello world'
    openFindBar()
    setFindQuery('hello')
    expect(surface.querySelectorAll('mark.find-hit').length).toBe(1)

    setFindQuery('')

    expect($findInPage.get()).toMatchObject({ matchCount: 0, matchOrdinal: 0, query: '' })
    expect(surface.querySelectorAll('mark.find-hit').length).toBe(0)
  })

  it('will not search for a closed bar — a fired debounce must not re-highlight', () => {
    plantSurface()
    openFindBar()
    closeFindBar()

    setFindQuery('late')
    findNext()

    expect($findInPage.get().query).toBe('')
    expect($findInPage.get().matchCount).toBe(0)
  })

  it('closes once, not twice — Escape is a shared gesture', () => {
    const surface = plantSurface()

    surface.textContent = 'hello'
    openFindBar()
    setFindQuery('hello')
    expect(surface.querySelectorAll('mark.find-hit').length).toBe(1)

    closeFindBar()
    closeFindBar()

    expect($findInPage.get().active).toBe(false)
    expect(surface.querySelectorAll('mark.find-hit').length).toBe(0)
  })

  it('accepts bridge results for secondary-window renderers', () => {
    plantSurface()
    openFindBar()
    setFindQuery('hello')
    setFindQuery('')

    updateFindResults(1, 9)

    expect($findInPage.get().matchCount).toBe(9)
    expect($findInPage.get().matchOrdinal).toBe(1)
  })
})
