import { Codecs, persistentAtom } from '@/lib/persisted'
import { atom } from '@/store/atom'

// Composer input history (persisted) + a send-while-busy queue (Gc7).

const MAX_HISTORY = 50

export const $history = persistentAtom<string[]>('hermes.composerHistory', [], Codecs.stringArray)
export const $queue = atom<string[]>([])

export function pushHistory(text: string): void {
  const value = text.trim()
  if (!value) return
  const prev = $history.get().filter(h => h !== value)
  $history.set([value, ...prev].slice(0, MAX_HISTORY))
}

export function enqueue(text: string): void {
  $queue.set([...$queue.get(), text])
}

export function dequeue(): string | undefined {
  const q = $queue.get()
  if (q.length === 0) return undefined
  $queue.set(q.slice(1))
  return q[0]
}

/** Remove and return the queued prompt at `index` (queue-panel send-now/delete). */
export function removeQueuedAt(index: number): string | undefined {
  const q = $queue.get()
  if (index < 0 || index >= q.length) return undefined
  const removed = q[index]
  $queue.set([...q.slice(0, index), ...q.slice(index + 1)])
  return removed
}
