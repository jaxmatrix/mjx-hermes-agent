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

export function setTranslucency(intensity: number): void {
  const clamped = Math.min(100, Math.max(0, Math.round(intensity)))
  $translucency.set(clamped)
  void applyTranslucency(clamped)
}

/** Apply the persisted translucency once at startup. */
export function initTranslucency(): void {
  void applyTranslucency($translucency.get())
}
