/**
 * `hermesDesktop.quickEntry` — settings IPC + event-bus join.
 *
 * Electron SoT: `quick-entry.ts` + main settings handlers. Window text/state
 * rides `app/quick-entry/channel.ts` (same events Electron forwarded through
 * main). OS chord + preference → Rust `quick_entry.rs`.
 */

import {
  emitQuickEntryState,
  emitQuickEntrySubmit,
  onQuickEntryShown,
  onQuickEntrySubmit,
  QUICK_ENTRY_STATE_EVENT
} from '@/app/quick-entry/channel'
import { IS_DESKTOP } from '@/lib/platform'
import type {
  QuickEntryStatePush,
  QuickEntryStatus,
  QuickEntrySubmitPayload
} from '@/store/quick-entry'

type Bridge = NonNullable<typeof window.hermesDesktop>
type QuickEntry = Bridge['quickEntry']

export const QUICK_ENTRY_TOGGLE_EVENT = 'hermes://quick-entry-toggle'

async function invokeNative<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')

  return invoke<T>(command, args)
}

function listenEvent(event: string, callback: (payload: unknown) => void): () => void {
  let stop: (() => void) | undefined
  let cancelled = false

  void import('@tauri-apps/api/event')
    .then(({ listen }) => {
      if (cancelled) {
        return undefined
      }

      return listen(event, message => callback(message.payload))
    })
    .then(unlisten => {
      if (!unlisten) {
        return
      }

      if (cancelled) {
        unlisten()
      } else {
        stop = unlisten
      }
    })
    .catch(() => undefined)

  return () => {
    cancelled = true
    stop?.()
  }
}

const getSettings: QuickEntry['getSettings'] = async () =>
  invokeNative<QuickEntryStatus>('quick_entry_settings_get')

const setSettings: QuickEntry['setSettings'] = async patch =>
  invokeNative<QuickEntryStatus>('quick_entry_settings_set', { patch: patch ?? {} })

const submit: QuickEntry['submit'] = payload => {
  const text = typeof payload?.text === 'string' ? payload.text.trim() : ''

  if (text) {
    void emitQuickEntrySubmit({
      target: typeof payload?.target === 'string' && payload.target ? payload.target : 'current',
      text
    })
  }

  void import('@/app/quick-entry/quick-entry').then(({ closeQuickEntry }) => closeQuickEntry())
}

const dismiss: QuickEntry['dismiss'] = () => {
  void import('@/app/quick-entry/quick-entry').then(({ closeQuickEntry }) => closeQuickEntry())
}

const pushState: QuickEntry['pushState'] = payload => {
  void emitQuickEntryState(payload)
}

const onState: QuickEntry['onState'] = callback =>
  listenEvent(QUICK_ENTRY_STATE_EVENT, payload => {
    const record = payload && typeof payload === 'object' ? (payload as QuickEntryStatePush) : null

    callback({
      connected: record?.connected === true,
      sessions: Array.isArray(record?.sessions) ? record.sessions : []
    })
  })

const onSubmit: QuickEntry['onSubmit'] = callback => {
  let stop: (() => void) | undefined
  let cancelled = false

  void onQuickEntrySubmit(raw => {
    if (!cancelled) {
      callback(raw as QuickEntrySubmitPayload | string)
    }
  }).then(off => {
    if (cancelled) {
      off()
    } else {
      stop = off
    }
  })

  return () => {
    cancelled = true
    stop?.()
  }
}

const onShown: QuickEntry['onShown'] = callback => {
  let stop: (() => void) | undefined
  let cancelled = false

  void onQuickEntryShown(() => {
    if (!cancelled) {
      callback()
    }
  }).then(off => {
    if (cancelled) {
      off()
    } else {
      stop = off
    }
  })

  return () => {
    cancelled = true
    stop?.()
  }
}

/** Arm the OS-chord toggle listener once (main window). */
export function installQuickEntryToggleListener(): () => void {
  if (!IS_DESKTOP) {
    return () => undefined
  }

  return listenEvent(QUICK_ENTRY_TOGGLE_EVENT, () => {
    void import('@/app/quick-entry/quick-entry').then(({ toggleQuickEntry }) => toggleQuickEntry())
  })
}

export const quickEntryBridge: Pick<Bridge, 'quickEntry'> | Record<string, never> = IS_DESKTOP
  ? {
      quickEntry: {
        getSettings,
        setSettings,
        submit,
        dismiss,
        pushState,
        onState,
        onSubmit,
        onShown
      }
    }
  : {}
