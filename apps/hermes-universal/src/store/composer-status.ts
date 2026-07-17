import { atom } from '@/store/atom'

// STUB — desktop's composer-status polls the gateway for background processes
// and groups them with todos/subagents into the status stack. Universal's
// status stack (composer/status-stack) renders only subagents + queue, so the
// only export the ported tree consumes is this presence atom, kept empty until
// a background-process feed lands. FLAG(chat-port).

export interface ComposerStatusItem {
  id: string
  sessionId?: string
  state?: 'running' | 'done'
}

// Keyed by runtime session id; always empty in universal for now.
export const $statusItemsBySession = atom<Record<string, ComposerStatusItem[]>>({})
