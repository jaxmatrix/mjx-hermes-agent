import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $notifications, clearNotifications, dismissNotification, notify, notifyError } from './notifications'

describe('notifications store', () => {
  beforeEach(() => clearNotifications())
  afterEach(() => {
    clearNotifications()
    vi.useRealTimers()
  })

  it('adds a notification and returns its id', () => {
    const id = notify({ kind: 'info', message: 'hello' })
    const list = $notifications.get()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id, kind: 'info', message: 'hello' })
  })

  it('newest first, capped at 4', () => {
    for (let i = 0; i < 6; i++) {
      notify({ kind: 'error', message: `m${i}` })
    }

    const list = $notifications.get()
    expect(list).toHaveLength(4)
    expect(list[0].message).toBe('m5')
  })

  it('errors/warnings default to a persistent top-center placement', () => {
    notify({ kind: 'error', message: 'boom' })
    expect($notifications.get()[0].placement).toBe('default')
    clearNotifications()
    notify({ kind: 'success', message: 'saved' })
    expect($notifications.get()[0].placement).toBe('bottom-right')
  })

  it('auto-dismisses transient kinds after their duration', () => {
    vi.useFakeTimers()
    notify({ kind: 'success', message: 'saved', durationMs: 1000 })
    expect($notifications.get()).toHaveLength(1)
    vi.advanceTimersByTime(1000)
    expect($notifications.get()).toHaveLength(0)
  })

  it('errors persist (duration 0) until dismissed', () => {
    vi.useFakeTimers()
    const id = notify({ kind: 'error', message: 'boom' })
    vi.advanceTimersByTime(60_000)
    expect($notifications.get()).toHaveLength(1)
    dismissNotification(id)
    expect($notifications.get()).toHaveLength(0)
  })

  it('notifyError summarizes a known error and keeps the raw as detail', () => {
    notifyError(new Error('Incorrect API key provided: sk-xxxx'), 'API key rejected')
    const n = $notifications.get()[0]
    expect(n.kind).toBe('error')
    expect(n.title).toBe('API key rejected')
    expect(n.message).toBe('OpenAI rejected the API key.')
    expect(n.detail).toContain('Incorrect API key provided')
  })

  it('runs onDismiss callbacks on clear', () => {
    const onDismiss = vi.fn()
    notify({ kind: 'info', message: 'x', onDismiss })
    clearNotifications()
    expect(onDismiss).toHaveBeenCalledOnce()
  })
})
