import { beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  calls: [] as [string, Record<string, unknown> | undefined][]
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => {
    native.calls.push([command, args])
  })
}))

vi.mock('@/lib/clipboard-tauri', () => ({
  readClipboardText: vi.fn(async () => 'pasted')
}))

import { __setLastContextPointForTests, contextMenuBridge } from './context-menu'

beforeEach(() => {
  native.calls = []
  __setLastContextPointForTests(null)
  document.body.innerHTML = ''
})

describe('hermesDesktop context menu', () => {
  it('contextMenuEdit paste inserts clipboard text', async () => {
    const field = document.createElement('textarea')

    document.body.appendChild(field)
    field.focus()

    const execCommand = vi.fn().mockReturnValue(true)

    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand })

    await contextMenuBridge.contextMenuEdit!('paste')

    expect(execCommand).toHaveBeenCalledWith('insertText', false, 'pasted')
  })

  it('contextMenuCopyImage copies the img under the last gesture', async () => {
    const img = document.createElement('img')

    img.src = 'data:image/png;base64,aa'
    document.body.appendChild(img)

    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: () => img
    })
    __setLastContextPointForTests({ x: 5, y: 5 })

    await contextMenuBridge.contextMenuCopyImage!()

    expect(native.calls).toEqual([
      ['context_menu_copy_image', { source: { kind: 'data', value: 'data:image/png;base64,aa' } }]
    ])
  })
})
