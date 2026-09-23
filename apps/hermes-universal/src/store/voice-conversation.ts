import type { ComposerTarget } from '@/app/chat/composer/focus'
import { atom } from '@/store/atom'

// The React-facing view of a running voice conversation. The loop itself lives in
// `voice/conversation-controller.ts` (a module-level class, not a hook), and this
// atom is its render surface: `useVoiceConversation` is a thin `useStore` mirror.
// `status` keeps the exact union the old hook exposed so `ConversationPill` and the
// locale strings are untouched — it is a DERIVED view of (Rust VoiceStateKind ×
// playback), not the source of truth.

export type ConversationStatus = 'idle' | 'listening' | 'transcribing' | 'thinking' | 'speaking'

export interface VoiceConversationState {
  active: boolean
  /** Which composer owns the conversation (so a tile shows its own pill only). */
  target: ComposerTarget | null
  status: ConversationStatus
  level: number
  muted: boolean
}

const IDLE: VoiceConversationState = {
  active: false,
  target: null,
  status: 'idle',
  level: 0,
  muted: false
}

export const $voiceConversation = atom<VoiceConversationState>(IDLE)

export function resetVoiceConversation(): void {
  $voiceConversation.set(IDLE)
}

export function beginVoiceConversation(target: ComposerTarget): void {
  $voiceConversation.set({ active: true, target, status: 'listening', level: 0, muted: false })
}

function patch(next: Partial<VoiceConversationState>): void {
  $voiceConversation.set({ ...$voiceConversation.get(), ...next })
}

export function setConversationStatus(status: ConversationStatus): void {
  patch({ status })
}

export function setConversationLevel(level: number): void {
  patch({ level })
}

export function setConversationMuted(muted: boolean): void {
  patch({ muted })
}
