/**
 * DOM classification — the half that decides what a gesture LANDED on.
 *
 * Every case here is a shape the app actually renders: a markdown link, an
 * attachment thumbnail wrapped in an anchor, the composer's textarea, a
 * read-only field in Settings.
 */

import { afterEach, describe, expect, it } from 'vitest'

import { editableFrom, isLoopbackUrl, isWebUrl, resolveDomTarget } from './target'

function mount(html: string): HTMLElement {
  document.body.innerHTML = html

  return document.body.firstElementChild as HTMLElement
}

afterEach(() => {
  document.body.innerHTML = ''
  window.getSelection()?.removeAllRanges()
})

describe('resolveDomTarget', () => {
  it('resolves an anchor and its href AS WRITTEN', () => {
    const anchor = mount('<a href="/docs/readme.md">readme</a>')

    // Not `anchor.href`, which jsdom absolutizes to `http://localhost/…` — a
    // relative in-app link must not become a URL nothing can open.
    expect(resolveDomTarget(anchor).linkUrl).toBe('/docs/readme.md')
  })

  it('ignores a placeholder anchor', () => {
    expect(resolveDomTarget(mount('<a href="#">nowhere</a>')).linkUrl).toBe('')
  })

  it('resolves an image and the anchor wrapping it — both sections’ facts', () => {
    const wrapper = mount('<a href="https://example.test/full"><img src="data:image/png;base64,AA"></a>')
    const target = resolveDomTarget(wrapper.querySelector('img'))

    expect(target.linkUrl).toBe('https://example.test/full')
    expect(target.imageUrl).toBe('data:image/png;base64,AA')
    expect(target.onImage).toBe(true)
  })

  it('reports a broken image as an image with no url', () => {
    const image = mount('<img alt="broken">')
    const target = resolveDomTarget(image)

    expect(target.onImage).toBe(true)
    expect(target.imageUrl).toBe('')
  })

  it('resolves input, textarea and contenteditable', () => {
    expect(editableFrom(mount('<input type="text">'))).toBeInstanceOf(HTMLInputElement)
    expect(editableFrom(mount('<textarea></textarea>'))).toBeInstanceOf(HTMLTextAreaElement)
    expect(editableFrom(mount('<div contenteditable="true">draft</div>'))).toBeInstanceOf(HTMLDivElement)
  })

  it('returns null for disabled, readOnly and non-text fields', () => {
    expect(editableFrom(mount('<input type="text" disabled>'))).toBeNull()
    expect(editableFrom(mount('<textarea readonly></textarea>'))).toBeNull()
    expect(editableFrom(mount('<input type="checkbox">'))).toBeNull()
    expect(editableFrom(mount('<div contenteditable="false">read me</div>'))).toBeNull()
  })

  it('prefers the editable over a link wrapping it', () => {
    const wrapper = mount('<a href="https://example.test/"><span contenteditable="true">draft</span></a>')
    const target = resolveDomTarget(wrapper.querySelector('span'))

    expect(target.editable).not.toBeNull()
    expect(target.linkUrl).toBe('')
  })

  it('reads a live document selection', () => {
    const host = mount('<p>hello world</p>')
    const range = document.createRange()

    range.selectNodeContents(host)
    window.getSelection()?.addRange(range)

    expect(resolveDomTarget(host).selectionText).toBe('hello world')
  })

  it('is total — a null element still yields a target', () => {
    expect(resolveDomTarget(null)).toEqual({
      editable: null,
      imageUrl: '',
      linkUrl: '',
      onImage: false,
      selectionText: ''
    })
  })
})

describe('url predicates', () => {
  it('accepts only http(s) as a web url', () => {
    expect(isWebUrl('https://example.test/')).toBe(true)
    expect(isWebUrl('HTTP://example.test/')).toBe(true)
    expect(isWebUrl('/workspace/a.png')).toBe(false)
    expect(isWebUrl('data:image/png;base64,AA')).toBe(false)
    expect(isWebUrl('file:///etc/hosts')).toBe(false)
  })

  it('recognises loopback hosts and nothing else', () => {
    expect(isLoopbackUrl('http://localhost:8080/preview')).toBe(true)
    expect(isLoopbackUrl('http://127.0.0.1/')).toBe(true)
    expect(isLoopbackUrl('http://[::1]:3000/')).toBe(true)
    expect(isLoopbackUrl('https://example.test/')).toBe(false)
    expect(isLoopbackUrl('not a url')).toBe(false)
  })
})
