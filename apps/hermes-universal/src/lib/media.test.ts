/**
 * Media helpers that do not need a live `window.hermesDesktop` stub.
 *
 * Remote-gateway resolution, display src, and download behaviour are covered in
 * `media.remote.test.ts` (desktop ground truth for universal's only route).
 */

import { afterEach, describe, expect, it } from 'vitest'

import { $connection } from '@/store/session'

import {
  filePathFromMediaPath,
  isInlineMediaSrc,
  mediaExternalUrl,
  mediaKind
} from './media'

describe('filePathFromMediaPath', () => {
  it('passes through a plain path', () => {
    expect(filePathFromMediaPath('/tmp/a.png')).toBe('/tmp/a.png')
  })

  it('decodes a file:// URL with encoded characters', () => {
    expect(filePathFromMediaPath('file:///tmp/my%20shot%20%231.png')).toBe('/tmp/my shot #1.png')
  })
})

describe('isInlineMediaSrc', () => {
  it('recognises the sources that need no resolution', () => {
    expect(isInlineMediaSrc('https://cdn.example/a.png')).toBe(true)
    expect(isInlineMediaSrc('data:image/png;base64,AAA')).toBe(true)
    expect(isInlineMediaSrc('/tmp/a.png')).toBe(false)
    expect(isInlineMediaSrc('file:///tmp/a.png')).toBe(false)
  })
})

describe('mediaExternalUrl', () => {
  afterEach(() => {
    $connection.set(null)
  })

  it('passes through http(s) URLs untouched', () => {
    $connection.set({ mode: 'remote', baseUrl: 'https://gw', token: 't' } as never)
    expect(mediaExternalUrl('https://cdn.example/a.png')).toBe('https://cdn.example/a.png')
  })

  it('rewrites gateway-local paths to a download URL, carrying the token when there is one', () => {
    $connection.set({ mode: 'remote', baseUrl: 'https://gw.example', token: 't/k' } as never)

    expect(mediaExternalUrl('/work/a b.png')).toBe(
      'https://gw.example/api/files/download?path=%2Fwork%2Fa%20b.png&token=t%2Fk'
    )
  })

  it('falls back to file:// when remote connection lacks a token', () => {
    $connection.set({ baseUrl: 'https://gw.example', mode: 'remote' } as never)

    expect(mediaExternalUrl('/work/a.png')).toBe('file:///work/a.png')
  })
})

describe('mediaKind', () => {
  it('classifies by extension, which is what picks the element that renders it', () => {
    expect(mediaKind('/tmp/clip.mp4')).toBe('video')
    expect(mediaKind('/tmp/note.mp3')).toBe('audio')
    expect(mediaKind('/tmp/pic.PNG')).toBe('image')
    expect(mediaKind('/tmp/notes.txt')).toBe('file')
    expect(mediaKind('/tmp/no-extension')).toBe('file')
  })
})
