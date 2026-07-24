// Split a growing assistant reply into speakable chunks. Pure port of the logic
// that used to live inline in `use-voice-conversation.ts` (`takeSpeechChunk`), so
// the voice loop can speak stable sentences as the stream grows without waiting
// for the whole reply. Extracted here to be unit-testable and reusable.

export interface SpeechChunk {
  /** A speakable chunk, or null if the buffer has no stable boundary yet. */
  chunk: string | null
  /** What remains in the buffer after taking `chunk`. */
  rest: string
}

/**
 * Take the next speakable chunk from `rawBuffer`.
 *
 * - A leading sentence (ending `.!?。！？`) is taken once it is at least 8 chars,
 *   or immediately when `force`.
 * - Otherwise, when not forcing and the buffer is long (>220), it is split at the
 *   last soft boundary (`, ` / `; ` / `: `) before index 180 (past index 80).
 * - When `force`, whatever remains is flushed as one final chunk.
 * - Otherwise nothing is taken yet.
 */
export function takeSpeechChunk(rawBuffer: string, force = false): SpeechChunk {
  const buffer = rawBuffer.replace(/\s+/g, ' ').trim()

  if (!buffer) {
    return { chunk: null, rest: '' }
  }

  const sentence = buffer.match(/^(.+?[.!?。！？])(?:\s+|$)/)

  if (sentence?.[1] && (sentence[1].length >= 8 || force)) {
    return { chunk: sentence[1].trim(), rest: buffer.slice(sentence[1].length).trim() }
  }

  if (!force && buffer.length > 220) {
    const softBoundary = Math.max(
      buffer.lastIndexOf(', ', 180),
      buffer.lastIndexOf('; ', 180),
      buffer.lastIndexOf(': ', 180)
    )

    if (softBoundary > 80) {
      return { chunk: buffer.slice(0, softBoundary + 1).trim(), rest: buffer.slice(softBoundary + 1).trim() }
    }
  }

  if (!force) {
    return { chunk: null, rest: buffer }
  }

  return { chunk: buffer, rest: '' }
}
