import { atom } from 'nanostores'
import { describe, expect, it } from 'vitest'

import type { SessionView } from '@/app/chat/session-view'
import type { ChatMessage } from '@/lib/chat-messages'

import { lastReply, markReplySpoken, unspokenTurn } from './voice-reply-cursor'

// The rewrite these tests are about: universal's live assistant row carries an
// EPHEMERAL id (`m<N>-<ts>` from `nextId()`), and `lib/live-tail.ts`
// `reconcileLiveTail` replaces the whole row set with the authoritative
// transcript's (`h<N>-<role>`) on a cold-open rekey (`store/turn-hydration.ts`)
// or a reconnect resume (`store/turn-lifecycle.ts` `reconcileSessionTail`).
// Same reply, new id — which is exactly what an id-keyed cursor cannot see.

const user = (id: string, text: string): ChatMessage => ({ id, role: 'user', parts: [{ type: 'text', text }] })

/** A tool-only assistant bubble — `lib/session-history.ts` synthesizes one
 *  (`h-tools-<n>`) when a turn's tool calls cannot fold into an existing row,
 *  so a hydrate can grow an assistant bubble AHEAD of the one we spoke. */
const toolBubble = (id: string): ChatMessage => ({
  id,
  role: 'assistant',
  parts: [{ type: 'tool-call', toolCallId: `${id}-call`, toolName: 'read' }]
})

const reply = (id: string, text: string, pending = false): ChatMessage => ({
  id,
  role: 'assistant',
  parts: [{ type: 'text', text }],
  ...(pending ? { pending: true } : {})
})

function fakeView(messages: ChatMessage[]) {
  const $messages = atom(messages)

  // Only `$messages` is read by the cursor; the rest of SessionView is inert here.
  return { $messages, view: { $messages } as unknown as SessionView }
}

/** What `useAutoSpeakReplies`' `speakLatest` does, minus the playback plumbing:
 *  skip while pending or already spoken, otherwise mark and utter. */
function autoSpeak(view: SessionView, spoken: string[]): void {
  const next = lastReply(view)

  if (!next || next.pending) {
    return
  }

  markReplySpoken(view)
  spoken.push(next.text)
}

describe('auto-speak across the row-id rewrite', () => {
  it('speaks a turn ONCE when hydrate re-keys the row it just read', () => {
    const spoken: string[] = []
    const { $messages, view } = fakeView([user('m6-1', 'what is it'), reply('m7-1', '', true)])

    // Streaming: nothing to read yet.
    autoSpeak(view, spoken)
    expect(spoken).toEqual([])

    // The turn settles under its LOCAL id and is read aloud.
    $messages.set([user('m6-1', 'what is it'), reply('m7-1', 'The answer.')])
    autoSpeak(view, spoken)
    expect(spoken).toEqual(['The answer.'])

    // `reconcileLiveTail` swaps in the authoritative transcript: same two turns,
    // new ids. Every one of these publications re-runs `speakLatest`.
    $messages.set([user('h0-user', 'what is it'), reply('h1-assistant', 'The answer.')])
    autoSpeak(view, spoken)

    expect(spoken).toEqual(['The answer.'])
  })

  it('still speaks the NEXT turn after a rewrite', () => {
    const spoken: string[] = []
    const { $messages, view } = fakeView([user('m6-1', 'what is it'), reply('m7-1', 'The answer.')])

    autoSpeak(view, spoken)
    $messages.set([user('h0-user', 'what is it'), reply('h1-assistant', 'The answer.')])
    autoSpeak(view, spoken)

    // A genuinely new turn lands on the re-keyed transcript.
    $messages.set([
      user('h0-user', 'what is it'),
      reply('h1-assistant', 'The answer.'),
      user('m8-1', 'and again'),
      reply('m9-1', 'The answer.')
    ])
    autoSpeak(view, spoken)

    // Same TEXT as the previous turn, deliberately: a content fingerprint would
    // swallow this one, and "Done." twice in a row is the common case.
    expect(spoken).toEqual(['The answer.', 'The answer.'])
  })

  it('reads nothing for a transcript that was already on screen when auto-speak armed', () => {
    const spoken: string[] = []
    const { $messages, view } = fakeView([user('h0-user', 'earlier'), reply('h1-assistant', 'An older reply.')])

    // The arming edge in `useAutoSpeakReplies`: consume whatever sits at the bottom.
    markReplySpoken(view)
    autoSpeak(view, spoken)

    // ...and it survives the rewrite of that same older transcript.
    $messages.set([user('h0-user', 'earlier'), reply('h1-assistant-v2', 'An older reply.')])
    autoSpeak(view, spoken)

    expect(spoken).toEqual([])
  })
})

describe('the conversation loop across the row-id rewrite', () => {
  it('does not re-narrate the whole session when the cursor id is rewritten', () => {
    const { $messages, view } = fakeView([
      user('h0-user', 'first'),
      reply('h1-assistant', 'First answer.'),
      user('m6-1', 'second'),
      reply('m7-1', 'Second answer.')
    ])

    markReplySpoken(view)
    expect(unspokenTurn(view)).toBeNull()

    // Reconnect: the tail commits under authoritative ids.
    $messages.set([
      user('h0-user', 'first'),
      reply('h1-assistant', 'First answer.'),
      user('h2-user', 'second'),
      reply('h3-assistant', 'Second answer.')
    ])

    // `collectUnspokenTurnSpeech` starts from index 0 when it cannot find the
    // cursor, so an unmigrated anchor makes the loop read the session back.
    expect(unspokenTurn(view)).toBeNull()
  })

  it('migrates onto the SLOT it was marked on, not the first reply in the session', () => {
    const { $messages, view } = fakeView([
      user('h0-user', 'first'),
      reply('h1-assistant', 'First answer.'),
      user('m6-1', 'second'),
      reply('m7-1', 'Second answer.')
    ])

    // Marked on the SECOND reply — ordinal 1, and that is the number that has
    // to survive. Anchoring at 0 would re-offer 'Second answer.' below.
    markReplySpoken(view)

    // A resume re-keys the whole transcript AND a third turn lands.
    $messages.set([
      user('h0-user', 'first'),
      reply('h1-assistant', 'First answer.'),
      user('h2-user', 'second'),
      reply('h3-assistant', 'Second answer.'),
      user('h4-user', 'third'),
      reply('h5-assistant', 'Third answer.')
    ])

    expect(unspokenTurn(view)?.text).toBe('Third answer.')
  })

  it('follows the spoken reply when a hydrate inserts a bubble AHEAD of it', () => {
    const { $messages, view } = fakeView([
      reply('h1-assistant', 'First answer.'),
      user('m6-1', 'second'),
      reply('m7-1', 'Second answer.')
    ])

    markReplySpoken(view)

    // Hydrate folds the turn's tool calls into their own bubble, pushing the
    // spoken reply from ordinal 1 to ordinal 2. Its id is untouched here, so
    // nothing is re-read — but the cursor has to NOTICE it moved.
    $messages.set([
      reply('h1-assistant', 'First answer.'),
      user('m6-1', 'second'),
      toolBubble('h-tools-2'),
      reply('m7-1', 'Second answer.')
    ])
    expect(unspokenTurn(view)).toBeNull()

    // Only now does a resume re-key everything, and a third turn lands. With a
    // stale ordinal the anchor migrates onto the TOOL bubble and 'Second
    // answer.' is narrated a second time.
    $messages.set([
      reply('h1-assistant', 'First answer.'),
      user('h2-user', 'second'),
      toolBubble('h-tools-3'),
      reply('h4-assistant', 'Second answer.'),
      user('h5-user', 'third'),
      reply('h6-assistant', 'Third answer.')
    ])

    expect(unspokenTurn(view)?.text).toBe('Third answer.')
  })

  it('narrates only the turn after the cursor once the anchor has migrated', () => {
    const { $messages, view } = fakeView([user('h0-user', 'first'), reply('h1-assistant', 'First answer.')])

    markReplySpoken(view)
    $messages.set([
      user('h0-user', 'first'),
      reply('h1-assistant-v2', 'First answer.'),
      user('m8-1', 'second'),
      reply('m9-1', 'Second answer.')
    ])

    expect(unspokenTurn(view)?.text).toBe('Second answer.')
  })
})
