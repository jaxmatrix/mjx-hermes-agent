/**
 * The terminal's menu-handle registry. Keyed by the host ELEMENT, so a destroyed
 * terminal's handle is collected with its node.
 */

import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { TERMINAL_HOST_ATTR } from '@/app/context-menu/markers'

import { registerTerminalContextMenu, terminalMenuHandleFor } from './context-menu'

function handle(selection: string) {
  return { getSelection: () => selection, paste: null, selectAll: () => undefined }
}

function mountTerminal(): { host: HTMLElement; inner: HTMLElement } {
  document.body.innerHTML = '<div data-terminal=""><div class="xterm-screen"><span>ls -la</span></div></div>'

  return {
    host: document.body.firstElementChild as HTMLElement,
    inner: document.querySelector('span') as HTMLElement
  }
}

describe('terminalMenuHandleFor', () => {
  it('resolves through closest([data-terminal]) from anywhere inside the canvas', () => {
    const { host, inner } = mountTerminal()

    registerTerminalContextMenu(host, handle('ls -la'))

    expect(terminalMenuHandleFor(inner)?.getSelection()).toBe('ls -la')
  })

  it('answers null outside a terminal, and for a host that never registered', () => {
    const { host } = mountTerminal()

    expect(terminalMenuHandleFor(host)).toBeNull()
    expect(terminalMenuHandleFor(document.body)).toBeNull()
    expect(terminalMenuHandleFor(null)).toBeNull()
  })

  it('replaces on re-registration and unregisters idempotently', () => {
    const { host } = mountTerminal()
    const release = registerTerminalContextMenu(host, handle('first'))

    registerTerminalContextMenu(host, handle('second'))
    release()
    release()

    // The stale unregister must not null a handle it no longer owns — a
    // remounting terminal would otherwise lose its menu on the old one's cleanup.
    expect(terminalMenuHandleFor(host)?.getSelection()).toBe('second')
  })
})

describe('the xterm host', () => {
  // The test that would have caught D1. `lib/keybinds/composer-focus-keys.ts`
  // has matched `[data-terminal]` since it was written, and the attribute was
  // stamped nowhere but that file's own test — so the focus scope was dead in
  // production and nothing said so. Rendering the whole view (xterm, WebGL, a
  // PTY socket) in jsdom to assert one attribute is not worth it; the source is.
  const source = fs.readFileSync(path.join(process.cwd(), 'src/app/right-pane/terminal/terminal-view.tsx'), 'utf8')

  it(`stamps ${TERMINAL_HOST_ATTR} on the element the FitAddon sizes`, () => {
    expect(source).toContain(`${TERMINAL_HOST_ATTR}=""`)
    expect(source).toContain('ref={hostRef}')
  })

  it('registers its menu handle against that same host, and releases it', () => {
    expect(source).toContain('registerTerminalContextMenu(host, {')
    expect(source).toContain('paste: procId ? null : ')
    expect(source).toContain('unregisterMenu()')
  })
})
