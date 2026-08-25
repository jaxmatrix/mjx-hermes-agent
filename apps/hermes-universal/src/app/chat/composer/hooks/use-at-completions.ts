import type { Unstable_TriggerAdapter, Unstable_TriggerItem } from '@assistant-ui/core'
import { useCallback } from 'react'

import { refChipLabel } from '@/components/assistant-ui/directive-text'
import { useContributions } from '@/contrib/react/use-contributions'
import type { HermesGateway } from '@/hermes'
import { cachedPathCompletion, hasCachedPathCompletion } from '@/lib/slash-completion-cache'
import { normalize } from '@/lib/text'

import { COMPOSER_AREAS, type ComposerAtCompletionSource } from '../contrib'

import type { CompletionEntry, CompletionPayload } from './use-live-completion-adapter'
import { useLiveCompletionAdapter } from './use-live-completion-adapter'

const KIND_RE = /^@(file|folder|url|image|tool|git):(.*)$/
const REF_STARTERS = new Set(['file', 'folder', 'url', 'image', 'tool', 'git'])

const STARTER_META: Record<string, string> = {
  file: 'Attach a file reference',
  folder: 'Attach a folder reference',
  url: 'Attach a URL reference',
  image: 'Attach an image reference',
  tool: 'Attach a tool reference',
  git: 'Attach git context'
}

function starterEntries(query: string): CompletionEntry[] {
  const q = normalize(query)
  const kinds = Array.from(REF_STARTERS)
  const filtered = q ? kinds.filter(kind => kind.startsWith(q)) : kinds

  return filtered.map(kind => ({
    text: `@${kind}:`,
    display: `@${kind}:`,
    meta: STARTER_META[kind] || ''
  }))
}

interface AtItemMetadata extends Record<string, string> {
  icon: string
  display: string
  meta: string
  /** Raw `text` field from the gateway, e.g. `@file:src/main.tsx` or `@diff`. */
  rawText: string
  /** Just the value portion (after `@kind:`), or empty for simple refs. */
  insertId: string
}

function textValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

/** Parse the gateway's `text` field (`@file:src/foo.ts`, `@diff`, `@folder:`) into popover-ready data. */
function classify(entry: CompletionEntry): {
  type: string
  insertId: string
  display: string
  meta: string
} {
  const match = KIND_RE.exec(entry.text)

  if (match) {
    const [, kind, rest] = match

    return {
      type: kind,
      insertId: rest,
      // The row must show exactly what picking it produces. The gateway's
      // `display` is a BASENAME (`methods_complete.py` emits `entry + suffix`),
      // while the chip this row inserts is labelled by `refChipLabel` off the
      // full `@kind:value` — so taking `display` verbatim gave one folder two
      // names: the list said `desktop/`, the editor said `apps/desktop/`. Worse
      // on the fuzzy branch, which ranks matches from anywhere in the tree and
      // returned every `index.ts` in the repo as the same undifferentiated row.
      // Both ends derive from `refChipLabel` now, so they cannot drift.
      display: rest ? refChipLabel(kind, rest) : textValue(entry.display, `@${kind}:`),
      meta: textValue(entry.meta)
    }
  }

  return {
    type: 'simple',
    insertId: entry.text,
    display: textValue(entry.display, entry.text),
    meta: textValue(entry.meta)
  }
}

/** Live `@` completions backed by the gateway's `complete.path` RPC, with
 *  contributed sources (`composer.atCompletions` — e.g. Bot Mode agent handles)
 *  merged ahead of the path results. */
export function useAtCompletions(options: {
  gateway: HermesGateway | null
  sessionId: string | null
  cwd: string | null
}): { adapter: Unstable_TriggerAdapter; loading: boolean } {
  const { gateway, sessionId, cwd } = options
  const enabled = Boolean(gateway)

  const contributed = useContributions(COMPOSER_AREAS.atCompletions)

  // Contributed rows for the query, mapped into the gateway's entry shape so ONE
  // classify/toItem path renders every row. Provider errors are isolated: a
  // throwing source drops ITS rows, never the popover — and it is not toasted,
  // because a completion list is not the place to report a plugin bug.
  const contributedEntries = useCallback(
    (query: string): CompletionEntry[] => {
      const out: CompletionEntry[] = []

      for (const contribution of contributed) {
        const source = contribution.data as ComposerAtCompletionSource | undefined

        if (typeof source?.provide !== 'function') {
          continue
        }

        try {
          for (const item of source.provide(query) || []) {
            if (typeof item?.insert === 'string' && item.insert) {
              out.push({
                display: item.display || item.insert,
                icon: item.icon || '',
                meta: item.meta || '',
                text: item.insert
              } as CompletionEntry)
            }
          }
        } catch {
          // A broken source must not take down `@` completions.
        }
      }

      return out
    },
    [contributed]
  )

  // The scope a listing is relative to. It namespaces the response cache below
  // AND is handed to the adapter as its epoch — both are needed. The cache key
  // alone protected nothing: the adapter answers a repeated query from the items
  // it is already holding and never calls the fetcher, so `@src/` typed in one
  // repo kept listing that repo's files after a session or project switch moved
  // the cwd. Changing the epoch is what makes it ask again.
  const scope = `${cwd ?? ''}|${sessionId ?? ''}`
  const cacheKey = useCallback((query: string) => `${scope}|${query}`, [scope])

  const fetcher = useCallback(
    async (query: string): Promise<CompletionPayload> => {
      const starters = starterEntries(query)
      const extras = contributedEntries(query)

      if (!gateway) {
        return { items: [...extras, ...starters], query }
      }

      const word = REF_STARTERS.has(query) ? `@${query}:` : `@${query}`
      const params: Record<string, unknown> = { word }

      if (sessionId) {
        params.session_id = sessionId
      }

      if (cwd) {
        params.cwd = cwd
      }

      try {
        // De-duplicated the same way `/` completions are. Walking a path is
        // inherently repetitive — Tab into a folder, Backspace out, retype a
        // segment — and every one of those steps was a fresh listing + rank on
        // the backend.
        const result = await cachedPathCompletion(cacheKey(query), () =>
          gateway.request<{ items?: CompletionEntry[] }>('complete.path', params)
        )

        const items = result.items ?? []
        const base = items.length > 0 ? items : starters

        // Contributed rows sort ABOVE the path results, matching desktop: a
        // plugin's handles are a small named set, and burying them under a file
        // listing is the same as not offering them.
        return { items: [...extras, ...base], query }
      } catch {
        return { items: [...extras, ...starters], query }
      }
    },
    [cacheKey, contributedEntries, gateway, sessionId, cwd]
  )

  const toItem = useCallback((entry: CompletionEntry, index: number): Unstable_TriggerItem => {
    const classified = classify(entry)

    const metadata: AtItemMetadata = {
      icon: classified.type,
      display: classified.display,
      meta: classified.meta,
      rawText: entry.text,
      insertId: classified.insertId
    }

    return {
      // Unique id keyed on the gateway's full `text` so two entries that share
      // a basename (e.g. multiple `index.ts`) don't collide in keyboard nav.
      id: `${entry.text}|${index}`,
      type: classified.type,
      label: classified.display,
      ...(classified.meta ? { description: classified.meta } : {}),
      metadata
    }
  }, [])

  // A query already in cache skips both the debounce and the loading state.
  // This is what makes walking a tree feel instant rather than merely fast:
  // the 60ms debounce exists to avoid a request per keystroke, and it buys
  // nothing when the answer is already in hand.
  const isCached = useCallback((query: string) => hasCachedPathCompletion(cacheKey(query)), [cacheKey])

  return useLiveCompletionAdapter({ enabled, epoch: scope, fetcher, isCached, toItem })
}

/** Re-export `classify` for use by the formatter (insertion side). */
export { classify }
