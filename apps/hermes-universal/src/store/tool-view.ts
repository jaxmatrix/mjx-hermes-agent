import { type Codec, persistentAtom } from '@/lib/persisted'

// Tool-call display mode (mirrors desktop `store/tool-view.ts`). `product` hides
// raw tool payloads; `technical` shows full input/output. Persisted per-device.
export type ToolViewMode = 'product' | 'technical'

const codec: Codec<ToolViewMode> = {
  decode: raw => (raw === 'technical' ? 'technical' : 'product'),
  encode: value => value
}

export const $toolViewMode = persistentAtom<ToolViewMode>('hermes.toolView', 'product', codec)

export const setToolViewMode = (mode: ToolViewMode) => $toolViewMode.set(mode)
