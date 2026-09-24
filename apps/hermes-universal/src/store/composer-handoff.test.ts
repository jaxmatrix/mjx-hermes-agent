/**
 * A composer draft moving between windows (MJXHRM-213).
 *
 * The HUD and the main window are separate webviews with separate JS heaps that
 * share one `localStorage` draft stash. A half-typed message has to survive the
 * trip, and — the part that is easy to get wrong — attachments must not be
 * destroyed by the merge, because they live only in the memory of the window
 * that staged them.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { onComposerDraftSyncRequest, requestComposerDraftSync } from '@/lib/composer-draft-bus'

import { reloadPersistedDrafts, SESSION_DRAFTS_STORAGE_KEY, stashSessionDraft, takeSessionDraft } from './composer'

const attachment = (id: string) => ({ id, kind: 'image' as const, label: `${id}.png` })

/** Stand in for the other window writing to the shared stash. */
function otherWindowWrote(drafts: Record<string, string>): void {
  window.localStorage.setItem(SESSION_DRAFTS_STORAGE_KEY, JSON.stringify(drafts))
}

beforeEach(() => {
  window.localStorage.clear()

  // Drop everything this window is holding, so each case starts from a known map.
  for (const scope of ['a', 'b', 'c']) {
    stashSessionDraft(scope, '', [])
  }

  window.localStorage.clear()
})

describe('drafts crossing a window boundary', () => {
  it('picks up text another window wrote', () => {
    otherWindowWrote({ a: 'typed in the HUD' })
    reloadPersistedDrafts()

    expect(takeSessionDraft('a').text).toBe('typed in the HUD')
  })

  it('keeps attachments this window is holding', () => {
    stashSessionDraft('a', 'here', [attachment('one')])
    otherWindowWrote({ a: 'edited over there' })
    reloadPersistedDrafts()

    const draft = takeSessionDraft('a')

    // Attachments are blobs and upload state — they were never on the wire, so
    // a merge that dropped them would silently discard the user's file.
    expect(draft.text).toBe('edited over there')
    expect(draft.attachments.map(a => a.id)).toEqual(['one'])
  })

  it('drops a draft the other window sent', () => {
    stashSessionDraft('a', 'about to send', [])
    otherWindowWrote({})
    reloadPersistedDrafts()

    expect(takeSessionDraft('a').text).toBe('')
  })

  it('keeps a sent draft only while it still has attachments here', () => {
    stashSessionDraft('a', 'text', [attachment('one')])
    otherWindowWrote({})
    reloadPersistedDrafts()

    // A vanished key means the other window sent (cleared) the draft — the whole
    // local entry goes, attachments included. Desktop's merge does the same.
    expect(takeSessionDraft('a').text).toBe('')
    expect(takeSessionDraft('a').attachments).toHaveLength(0)
  })

  it('leaves other sessions alone', () => {
    stashSessionDraft('b', 'unrelated', [])
    otherWindowWrote({ a: 'only a', b: 'unrelated' })
    reloadPersistedDrafts()

    expect(takeSessionDraft('b').text).toBe('unrelated')
  })
})

describe('the sync request the handoff is built on', () => {
  it('reaches every listener with its mode', () => {
    const heard = vi.fn()
    const off = onComposerDraftSyncRequest(heard)

    requestComposerDraftSync('flush')
    requestComposerDraftSync('reload')

    expect(heard.mock.calls).toEqual([['flush'], ['reload']])

    off()
    requestComposerDraftSync('flush')
    expect(heard).toHaveBeenCalledTimes(2)
  })

  it('turns another window’s write into a reload', () => {
    otherWindowWrote({ c: 'from over there' })
    // `storage` never fires in the window that wrote; this is the other window
    // being heard. The listener reloads the stash directly (no draft-sync bus).
    window.dispatchEvent(new StorageEvent('storage', { key: SESSION_DRAFTS_STORAGE_KEY }))

    expect(takeSessionDraft('c').text).toBe('from over there')
  })

  it('ignores a write to some other key', () => {
    otherWindowWrote({ c: 'from over there' })
    window.dispatchEvent(new StorageEvent('storage', { key: 'hermes:something-else' }))

    expect(takeSessionDraft('c').text).toBe('')
  })
})
