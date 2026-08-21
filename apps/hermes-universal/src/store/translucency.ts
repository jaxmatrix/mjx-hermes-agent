import { type Codec, persistentAtom } from '@/lib/persisted'
import { IS_DESKTOP } from '@/lib/platform'

// Window translucency (mirrors desktop `store/translucency.ts`). 0-100 intensity,
// applied via a native Rust command (`set_window_translucency`, window-vibrancy).
// Desktop-only; a no-op off Tauri or where the Rust command / platform can't do it.
const numberCodec: Codec<number> = {
  decode: raw => {
    const n = Number(raw)

    return Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : 0
  },
  encode: value => String(value)
}

export const $translucency = persistentAtom<number>('hermes.translucency', 0, numberCodec)

export async function applyTranslucency(intensity: number): Promise<void> {
  if (!IS_DESKTOP) {
    return
  }

  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('set_window_translucency', { intensity })
  } catch {
    // Rust command not present yet / platform unsupported — cosmetic, never surface.
  }
}

// The intensity slider fires an update per tick of the drag, and each one was
// an IPC wake into Rust. `window-vibrancy` (and the platform APIs under it)
// animates the material over ~150ms, so re-issuing the call per tick restarts
// that animation before it can ever settle — the drag is janky AND the frost
// levels look identical, because they never finish. Coalesce onto a trailing
// timer: the persisted value still moves per tick (nothing reads it until a
// cold start), only the native call waits for the hand to pause.
const TRANSLUCENCY_APPLY_DEBOUNCE_MS = 120

let applyTimer: null | number = null

function flushTranslucency(): void {
  applyTimer = null
  void applyTranslucency($translucency.get())
}

export function setTranslucency(intensity: number): void {
  const clamped = Math.min(100, Math.max(0, Math.round(intensity)))

  $translucency.set(clamped)

  if (applyTimer !== null) {
    clearTimeout(applyTimer)
  }

  applyTimer = setTimeout(flushTranslucency, TRANSLUCENCY_APPLY_DEBOUNCE_MS) as unknown as number
}

/** Apply a pending change now. The window closing mid-drag must not leave the
 *  native surface on the value the hand passed through 100ms ago. */
export function flushPendingTranslucency(): void {
  if (applyTimer !== null) {
    clearTimeout(applyTimer)
    flushTranslucency()
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushPendingTranslucency)
}

/** Apply the persisted translucency once at startup. */
export function initTranslucency(): void {
  void applyTranslucency($translucency.get())
}
