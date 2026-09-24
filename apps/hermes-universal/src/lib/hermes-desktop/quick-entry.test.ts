import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
const emit = vi.fn()
const listen = vi.fn()

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invoke(...args)
}))

vi.mock('@tauri-apps/api/event', () => ({
  emit: (...args: unknown[]) => emit(...args),
  listen: (...args: unknown[]) => listen(...args)
}))

vi.mock('@/lib/platform', () => ({
  IS_DESKTOP: true,
  IS_TAURI: true
}))

vi.mock('@/app/quick-entry/channel', () => ({
  QUICK_ENTRY_STATE_EVENT: 'hermes://quick-entry-state',
  emitQuickEntryState: vi.fn(async () => undefined),
  emitQuickEntrySubmit: vi.fn(async () => undefined),
  onQuickEntrySubmit: vi.fn(async () => () => undefined),
  onQuickEntryShown: vi.fn(async () => () => undefined)
}))

// submit/dismiss fire-and-forget `import('@/app/quick-entry/quick-entry')` to
// close the window. Without this stub the import keeps resolving after the
// suite tears down (pulling store → nanostores autocapture) and Vitest reports
// EnvironmentTeardownError even though every assertion already passed.
vi.mock('@/app/quick-entry/quick-entry', () => ({
  closeQuickEntry: vi.fn(),
  toggleQuickEntry: vi.fn()
}))

describe('quickEntryBridge', () => {
  beforeEach(() => {
    invoke.mockReset()
    emit.mockReset()
    listen.mockReset()
    listen.mockResolvedValue(() => undefined)
    invoke.mockResolvedValue({
      enabled: true,
      error: null,
      registered: true,
      shortcut: 'CommandOrControl+Shift+Space'
    })
    vi.resetModules()
  })

  it('reads and writes settings over Rust', async () => {
    const { quickEntryBridge } = await import('./quick-entry')

    await expect(quickEntryBridge.quickEntry!.getSettings()).resolves.toMatchObject({
      enabled: true,
      registered: true
    })
    expect(invoke).toHaveBeenCalledWith('quick_entry_settings_get', undefined)

    await quickEntryBridge.quickEntry!.setSettings({ enabled: false })
    expect(invoke).toHaveBeenCalledWith('quick_entry_settings_set', {
      patch: { enabled: false }
    })
  })

  it('submits over the channel then dismisses', async () => {
    const channel = await import('@/app/quick-entry/channel')
    const { quickEntryBridge } = await import('./quick-entry')

    quickEntryBridge.quickEntry!.submit({ target: 'current', text: 'hello' })

    await vi.waitFor(() => {
      expect(channel.emitQuickEntrySubmit).toHaveBeenCalledWith({
        target: 'current',
        text: 'hello'
      })
    })
  })
})
