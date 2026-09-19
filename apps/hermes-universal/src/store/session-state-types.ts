/**
 * The per-session state record + its shared atom — a LEAF module so every layer
 * (`store/chat.ts`, `store/session.ts`, `store/session-states.ts`,
 * `store/session-reducer.ts`) can read `$sessionKeyStates` without an import cycle.
 * The type imports are erased at build, so this file has no runtime deps beyond
 * nanostores.
 *
 * `$sessionKeyStates` is THE source of truth for EVERY session — the one on screen,
 * the ones in tiles, and the ones behind mobile bubbles. There is no separate
 * "primary" storage: the active chat is simply the slice `$activeSessionKey`
 * points at, and `store/chat.ts`'s `$messages`/`$busy`/… are computed
 * projections of it. That is what makes a background session's tokens land in
 * its own slice structurally, rather than by a guard that can fail open.
 *
 * (This inverts the earlier universal design, where the primary chat lived in
 * global atoms and `$sessionKeyStates` held tiles only — see MJX-132.)
 */

import { atom } from 'nanostores'

import type { ChatMessage } from '@/lib/chat-messages'
import { flushDeltas } from '@/lib/stream-batch'
import type { UsageStats } from '@/types/hermes'

/** The full client-side state of ONE session — the unit a chat surface renders
 *  from and the reducer writes per session key. Ported from desktop `app/types.ts`. */
export interface SessionKeyState {
  /** The gateway's LIVE session id, or null for a draft that has never been
   *  created. This is the only value safe to send as `session_id` on the wire. */
  runtimeSessionId: null | string
  storedSessionId: string | null
  /** The connection this session lives on, and the profile its stored id
   *  belongs to (MJXHRM-591). Carried on the slice rather than read from
   *  `$activeConnection`, because a background tab's session outlives every
   *  switch; `null` only for an unbound draft, which has no backend yet. */
  connectionId: null | string
  profile: null | string
  messages: ChatMessage[]
  branch: string
  cwd: string
  model: string
  provider: string
  reasoningEffort: string
  serviceTier: string
  fast: boolean
  yolo: boolean
  personality: string
  busy: boolean
  awaitingResponse: boolean
  streamId: string | null
  sawAssistantPayload: boolean
  pendingBranchGroup: string | null
  interrupted: boolean
  /** An interim finalized a bubble mid-turn. */
  interimBoundaryPending: boolean
  /** A blocking clarify prompt is waiting → sidebar "needs input". */
  needsInput: boolean
  /** Per-session turn clock (epoch ms). */
  turnStartedAt: number | null
  /** Per-session runtime clock (epoch ms), set when the session is created. */
  sessionStartedAt: number | null
  /** Per-session transient status text (the gateway's `status.update`). */
  statusLine: string
  /** Backend-pushed auto-title, before the session appears in the stored list. */
  liveTitle: string
  /** Last write, for LRU eviction (store/session-states.ts). */
  lastTouchedAt: number
  /** Per-session cumulative token usage. */
  usage: null | UsageStats
}

// ---------------------------------------------------------------------------
// Session keys. A session's map key is its RUNTIME id once it has one. Before
// that it still needs a slice — an unsaved draft must own its transcript like
// any other session, otherwise the active key is null and every foreign
// session's events fall through the "is this mine?" test (the MJX-132
// fail-open). So drafts and in-flight resumes get stable placeholder keys and
// are `rekeySession`d onto the real runtime id the moment the gateway hands one
// back.
// ---------------------------------------------------------------------------

export const DRAFT_KEY_PREFIX = 'draft:'
export const HYDRATING_KEY_PREFIX = 'hydrating:'

let draftCounter = 0

/** A fresh draft key. Counter-scoped so several unsaved chats can coexist (the
 *  mobile bubble strip allows more than one). */
export const newDraftKey = (): string => `${DRAFT_KEY_PREFIX}${++draftCounter}`

// ---------------------------------------------------------------------------
// SCOPED KEYS (MJXHRM-591). A session key names a session on ONE connection.
//
// Backend session ids are `uuid4().hex[:8]` minted per state.db
// (`tui_gateway/methods_session.py`), so 32 bits per database: two connections —
// and two profiles of one connection — collide in practice, not in theory. Every
// key therefore carries the scope that makes the id unique:
//
//   * a RUNTIME id is unique within one gateway process, so the connection alone
//     scopes it (one backend serves every profile of a connection);
//   * a STORED id lives in one profile's database, so the pair scopes it.
//
// Encoding. `local` (+ `default` for stored ids) keeps the BARE id, so every
// legacy key, persisted blob and log line stays byte-identical for single-source
// users — the rule `lib/backend-scope.ts` already states for pool keys. Every
// other scope is `@<part>|<part>[|<part>]`, each part `encodeURIComponent`d.
//
// Injective by construction: bare ids are hex (and placeholders are prefixed),
// so neither can begin with `@` — the two arms are prefix-free — and
// `encodeURIComponent` escapes both `|` (%7C) and `@` (%40) inside every part,
// so the separator cannot occur within one. `parseSessionKey` is the only reader:
// keys are OPAQUE to turn-lifecycle, prompts, journals and transcript paint,
// which take a string and never split it.
// ---------------------------------------------------------------------------

const SCOPED_KEY_MARKER = '@'
const SCOPED_KEY_SEPARATOR = '|'
/** The connection whose ids keep the bare, legacy spelling. */
export const LOCAL_SESSION_SCOPE = 'local'
/** The profile whose stored ids keep the bare, legacy spelling. */
export const DEFAULT_SESSION_PROFILE = 'default'

const scopeOf = (connectionId: null | string | undefined): string =>
  String(connectionId ?? '').trim() || LOCAL_SESSION_SCOPE

const profileOf = (profile: null | string | undefined): string =>
  String(profile ?? '').trim() || DEFAULT_SESSION_PROFILE

/** Whether a key already names its scope — `@conn|id`, minted by the helpers. */
export const isScopedKey = (key: string): boolean => key.startsWith(SCOPED_KEY_MARKER)

const scopedKey = (parts: readonly string[]): string =>
  SCOPED_KEY_MARKER + parts.map(encodeURIComponent).join(SCOPED_KEY_SEPARATOR)

/** Where a session lives: its connection, its profile and its stored id. The
 *  value a tab carries so no path has to ask which connection is active. */
export interface SessionRef {
  readonly connectionId: string
  readonly profile: string
  readonly storedSessionId: string
}

/** The map key for a LIVE session on `connectionId`. */
export function runtimeKeyFor(connectionId: null | string | undefined, runtimeId: string): string {
  const connection = scopeOf(connectionId)

  return connection === LOCAL_SESSION_SCOPE ? runtimeId : scopedKey([connection, runtimeId])
}

/** The reverse-index key for a STORED session in one profile of one connection. */
export function storedKeyFor(
  connectionId: null | string | undefined,
  profile: null | string | undefined,
  storedSessionId: string
): string {
  const connection = scopeOf(connectionId)
  const profileKey = profileOf(profile)

  return connection === LOCAL_SESSION_SCOPE && profileKey === DEFAULT_SESSION_PROFILE
    ? storedSessionId
    : scopedKey([connection, profileKey, storedSessionId])
}

/** The scope and id a key names. The ONLY reader of a key's shape. */
export function parseSessionKey(key: string): { connectionId: string; id: string; profile: null | string } {
  if (!key.startsWith(SCOPED_KEY_MARKER)) {
    return { connectionId: LOCAL_SESSION_SCOPE, id: key, profile: null }
  }

  const parts = key.slice(SCOPED_KEY_MARKER.length).split(SCOPED_KEY_SEPARATOR).map(decodeURIComponent)

  return parts.length >= 3
    ? { connectionId: parts[0], id: parts[2], profile: parts[1] }
    : { connectionId: parts[0], id: parts[1] ?? '', profile: null }
}

/**
 * The scope the AMBIENT chat's sessions live under (MJXHRM-591, invariant 45).
 *
 * The app's own chat belongs to whichever connection the app is pointed at, so
 * a lookup with no scope of its own means "the ambient one" — NOT "the bare
 * id", which is the collision the key scheme exists to close. Injected, because
 * this is a leaf and the active connection lives three layers up; it answers
 * local/default until something registers, which is what a single-source
 * install and every unit test have.
 */
type AmbientScope = (storedSessionId?: null | string) => { connectionId: string; profile: string }

let ambientScope: AmbientScope | null = null

export function setAmbientSessionScope(resolve: AmbientScope): void {
  ambientScope = resolve
}

/**
 * `storedSessionId` matters: a stored id lives in ONE profile's database, and
 * that profile is the session's own, not whichever the rail happens to show. The
 * writer and the reader both come through here, so the index cannot disagree
 * with itself.
 */
export function ambientSessionScope(storedSessionId?: null | string): { connectionId: string; profile: string } {
  return ambientScope?.(storedSessionId) ?? { connectionId: LOCAL_SESSION_SCOPE, profile: DEFAULT_SESSION_PROFILE }
}

/**
 * The connection a session key belongs to — what routing and teardown ask.
 *
 * NULL for a draft or hydrating placeholder (Design v1.3, N8): it has no
 * connection yet, and answering `local` made a switch away from local drop a
 * background draft that was bound to nothing at all.
 */
export const connectionOfSessionKey = (key: string): null | string =>
  isPlaceholderKey(key) ? null : parseSessionKey(key).connectionId

/** The key a stored session hydrates under until its resume returns a runtime
 *  id. Scoped, so two connections hydrating the same stored id are two slices. */
export const hydratingKeyFor = (ref: SessionRef): string =>
  `${HYDRATING_KEY_PREFIX}${storedKeyFor(ref.connectionId, ref.profile, ref.storedSessionId)}`

/**
 * The scoped stored key for the session a slice holds.
 *
 * The one place that answers "what do I file this session's durable state
 * under?" — its transcript tail, its artifacts, anything else keyed by stored id
 * that has to survive a resume. Derived from the slice, which carries its scope
 * from its first write, so two backends' identical stored ids are two files and
 * never one. Bare for the local connection's default profile, so every entry
 * already on disk keeps resolving.
 */
export function scopedStoredKey(sliceKey: string, storedSessionId: string): string {
  const slice = $sessionKeyStates.get()[sliceKey]

  return storedKeyFor(slice?.connectionId ?? connectionOfSessionKey(sliceKey), slice?.profile, storedSessionId)
}

/** The local connection's hydrating key — the bare, legacy spelling. */
export const hydratingKey = (storedSessionId: string): string =>
  hydratingKeyFor({ connectionId: LOCAL_SESSION_SCOPE, profile: DEFAULT_SESSION_PROFILE, storedSessionId })

export const isDraftKey = (key: string): boolean => key.startsWith(DRAFT_KEY_PREFIX)

export const isPlaceholderKey = (key: string): boolean =>
  key.startsWith(DRAFT_KEY_PREFIX) || key.startsWith(HYDRATING_KEY_PREFIX)

/** An empty state for a freshly-opened session before its resume binds. */
export function emptySessionState(storedSessionId: string | null = null): SessionKeyState {
  return {
    runtimeSessionId: null,
    storedSessionId,
    connectionId: null,
    profile: null,
    messages: [],
    branch: '',
    cwd: '',
    model: '',
    provider: '',
    reasoningEffort: '',
    serviceTier: '',
    fast: false,
    yolo: false,
    personality: '',
    busy: false,
    awaitingResponse: false,
    streamId: null,
    sawAssistantPayload: false,
    pendingBranchGroup: null,
    interrupted: false,
    interimBoundaryPending: false,
    needsInput: false,
    turnStartedAt: null,
    sessionStartedAt: null,
    statusLine: '',
    liveTitle: '',
    lastTouchedAt: 0,
    usage: null
  }
}

/** Session key → state, for EVERY session. Republished on every message delta;
 *  derived sets guard with `stableArray` to avoid re-render storms. */
export const $sessionKeyStates = atom<Record<string, SessionKeyState>>({})

/**
 * The key of the session the user is looking at — the map key, NEVER null.
 *
 * Deliberately distinct from `store/chat.ts`'s `$sessionId` (the gateway's
 * runtime id, which IS null for a draft and is what goes on the wire). Keeping
 * them separate is what lets the event router ask "is this event mine?" with a
 * value that always answers.
 */
export const $activeSessionKey = atom<string>(newDraftKey())

// ---------------------------------------------------------------------------
// THE MAP WRITE PATH.
//
// These live in the leaf, not in `store/session-states.ts`, because
// `store/chat.ts` needs them and `store/session-states.ts` reaches
// `store/session.ts` (which imports `store/chat.ts`) — putting the writers here
// keeps that from closing into a runtime cycle. The richer transition
// behaviour (stall watchdog, settle grace, unread markers, id rotation) plugs in
// through `setSessionTransitionHook`, and slice teardown through
// `setSessionDisposeHook`.
// ---------------------------------------------------------------------------

type TransitionHook = (previous: SessionKeyState | null, next: SessionKeyState, key: string) => void

let transitionHook: TransitionHook | null = null
let disposeHook: null | ((key: string, state: SessionKeyState) => void) = null

export function setSessionTransitionHook(hook: TransitionHook): void {
  transitionHook = hook
}

export function setSessionDisposeHook(hook: (key: string, state: SessionKeyState) => void): void {
  disposeHook = hook
}

/**
 * State keyed by session key that lives OUTSIDE the slice — the in-flight turn
 * (store/turn-lifecycle.ts) and the blocking prompts (store/prompts.ts).
 *
 * They need the same key moves the slice makes: a resume mints a fresh runtime
 * id for the same conversation, and anything still keyed on the old id is
 * stranded under a key nothing reads. That is how a clarify request survived
 * the reconnect on the wire but vanished from the UI — the agent stayed parked
 * in `_block` with no way to answer it.
 *
 * A hook rather than a direct call because those modules import THIS one; the
 * dependency has to point one way.
 */
interface SessionKeyHooks {
  drop: (key: string) => void
  /** `previous` is the slice AS IT WAS before the move — the only copy of the
   *  turn the outgoing key was mid-way through, which a hydrating rekey
   *  overwrites with the backend's answer. */
  rekey: (fromKey: string, toKey: string, previous: SessionKeyState) => void
}

const sessionKeyHooks = new Set<SessionKeyHooks>()

export function addSessionKeyHooks(hooks: SessionKeyHooks): () => void {
  sessionKeyHooks.add(hooks)

  return () => {
    sessionKeyHooks.delete(hooks)
  }
}

function fireSessionKeyHook(run: (hooks: SessionKeyHooks) => void): void {
  for (const hooks of sessionKeyHooks) {
    try {
      run(hooks)
    } catch {
      /* keyed side-state must never break the slice write */
    }
  }
}

// --- Stored id → session key reverse index --------------------------------
//
// Callers navigate by STORED id (a sidebar row, a tile, a bubble) but slices are
// keyed by the live session key, so every "is this session already open?" test
// needs this map. It also carries LINEAGE ALIASES: when a session auto-compacts
// its stored id rotates, and bubbles / tiles / layout pane ids / the persisted
// `hermes.*` blobs all still name the PRE-rotation id. Aliasing the old id onto
// the live key keeps every one of them resolving without renaming anything or
// migrating storage (MJX-133).

const keyByStoredId = new Map<string, string>()

/** The index key for a stored id belonging to the session under `key`: the
 *  slice's own connection scopes it, so connection A's `abc12345` and
 *  connection B's are two entries and never one (MJXHRM-591). */
const indexKeyFor = (key: string, state: SessionKeyState, storedSessionId: string): string =>
  storedKeyFor(state.connectionId ?? connectionOfSessionKey(key), state.profile, storedSessionId)

function indexStoredId(prev: SessionKeyState | null, next: SessionKeyState, key: string) {
  if (prev?.storedSessionId && prev.storedSessionId !== next.storedSessionId) {
    // Keep the old id pointing here — it is the same conversation, and the
    // callers holding it have no way to learn about the rotation.
    keyByStoredId.set(indexKeyFor(key, prev, prev.storedSessionId), key)
  }

  if (next.storedSessionId) {
    keyByStoredId.set(indexKeyFor(key, next, next.storedSessionId), key)
  }
}

function dropStoredIdIndexFor(key: string) {
  for (const [storedId, mapped] of keyByStoredId) {
    if (mapped === key) {
      keyByStoredId.delete(storedId)
    }
  }
}

function remapStoredIdIndex(key: string, nextKey: string) {
  for (const [storedId, mapped] of keyByStoredId) {
    if (mapped === key) {
      keyByStoredId.set(storedId, nextKey)
    }
  }
}

/**
 * The live session key for a stored session, or null when it isn't open.
 *
 * Validated like desktop's `getRuntimeIdForStoredSession`: a hit is only
 * returned when the slice still exists — either under its current stored id, or
 * under one we deliberately aliased across a compaction rotation.
 */
export function runtimeKeyForStoredSession(
  storedSessionId: null | string,
  scope?: Pick<SessionRef, 'connectionId' | 'profile'>
): null | string {
  if (!storedSessionId) {
    return null
  }

  const at = scope ?? ambientSessionScope(storedSessionId)
  const indexKey = storedKeyFor(at.connectionId, at.profile, storedSessionId)
  const key = keyByStoredId.get(indexKey)

  if (!key) {
    return null
  }

  if (!(key in $sessionKeyStates.get())) {
    keyByStoredId.delete(indexKey)

    return null
  }

  return key
}

/** Register a stored id as an alias of an already-open session — used to seed
 *  the index from the backend's `_lineage_root_id` on a session-list refresh.
 *  Both ids are scoped to the same connection and profile: an alias names the
 *  same conversation, so it can only ever live where the session does. */
export function aliasStoredSessionId(
  aliasStoredId: string,
  liveStoredId: string,
  scope?: Pick<SessionRef, 'connectionId' | 'profile'>
): void {
  const at = scope ?? ambientSessionScope(liveStoredId)
  const key = runtimeKeyForStoredSession(liveStoredId, at)
  const indexKey = storedKeyFor(at.connectionId, at.profile, aliasStoredId)

  if (key && !keyByStoredId.has(indexKey)) {
    keyByStoredId.set(indexKey, key)
  }
}

export function clearStoredIdIndex(): void {
  keyByStoredId.clear()
}

// --- Writers ---------------------------------------------------------------

/**
 * A slice's SCOPE is written once and never rewritten (MJXHRM-591, the
 * slice-level twin of invariant 38).
 *
 * It is set where the session is born — at creation, or at the binding rekey
 * that gives a hydrating placeholder its runtime key — and from then on it is
 * what every request, every index entry and every cache key for that session is
 * derived from. A later write moving it is not a correction: it is the same
 * repoint the tab type makes impossible to compile, arriving through the one
 * door that stays open. The first answer wins, silently, because a caller that
 * passed the wrong scope has already sent its RPC somewhere.
 */
function keepScope(prev: SessionKeyState | null, next: SessionKeyState): SessionKeyState {
  if (!prev || (prev.connectionId === null && prev.profile === null)) {
    return next
  }

  if (prev.connectionId === next.connectionId && prev.profile === next.profile) {
    return next
  }

  return { ...next, connectionId: prev.connectionId ?? next.connectionId, profile: prev.profile ?? next.profile }
}

/** The site a KEY names, for the two paths that hold a key and no ref: a write
 *  to a session that should already exist, and the router's blocking-prompt
 *  seed. A placeholder key is a draft site; anything else is its key's scope. */
export function siteOfKey(key: string): SessionSliceSite {
  if (isPlaceholderKey(key)) {
    return { draftKey: key }
  }

  const parsed = parseSessionKey(key)

  return {
    ref: {
      connectionId: parsed.connectionId,
      profile: parsed.profile ?? DEFAULT_SESSION_PROFILE,
      storedSessionId: ''
    },
    runtimeId: parsed.id
  }
}

/**
 * A runtime key's slice must carry the scope its key encodes (invariant 45).
 *
 * The key IS the address: a slice claiming another connection under it would be
 * routed, indexed and cached as that connection's, which is the collision the
 * key scheme exists to close. A scopeless slice under a runtime key adopts the
 * key's scope — that is the mint; a DISAGREEING one keeps the key's and says so,
 * because the write is the thing that is wrong, not the address it arrived at.
 */
function scopeToKey(key: string, state: SessionKeyState): SessionKeyState {
  if (isPlaceholderKey(key)) {
    return state
  }

  const parsed = parseSessionKey(key)
  const profile = parsed.profile ?? state.profile ?? DEFAULT_SESSION_PROFILE

  if (state.connectionId === parsed.connectionId && (state.profile ?? profile) === profile) {
    return state
  }

  if (state.connectionId && state.connectionId !== parsed.connectionId) {
    console.warn('[sessions] refusing a slice whose scope disagrees with its key', {
      key,
      slice: state.connectionId
    })
  }

  return { ...state, connectionId: parsed.connectionId, profile: state.profile ?? profile }
}

/** Publish one session's state, firing the transition side-effects by diffing
 *  previous vs next. */
export function publishSessionState(key: string, state: SessionKeyState): SessionKeyState {
  const prev = $sessionKeyStates.get()[key] ?? null
  const next = scopeToKey(key, keepScope(prev, { ...state, lastTouchedAt: Date.now() }))
  $sessionKeyStates.set({ ...$sessionKeyStates.get(), [key]: next })
  indexStoredId(prev, next, key)
  transitionHook?.(prev, next, key)

  return next
}

/**
 * WHERE a slice is being created (MJXHRM-591, invariant 45).
 *
 * A runtime slice may not exist without a scope, so the site carries it and the
 * key is minted here rather than by the caller: there is no way to ask for a
 * scoped key without the scope in hand, and no way to seed a slice under one
 * without it. The only sites with no scope are the ones that genuinely have
 * none — an unbound draft, which binds at its first `session.create`.
 */
export type SessionSliceSite = { draftKey: string } | { ref: SessionRef; runtimeId?: string }

/** The key a site names: a live session's, a cold open's placeholder, or the
 *  draft's own. */
export function sliceKeyFor(site: SessionSliceSite): string {
  if ('draftKey' in site) {
    return site.draftKey
  }

  return site.runtimeId ? runtimeKeyFor(site.ref.connectionId, site.runtimeId) : hydratingKeyFor(site.ref)
}

/** Create a session's slice if absent, and return it either way. Every write
 *  path goes through here, so no caller can land on a missing slice. */
export function ensureSessionSlice(site: SessionSliceSite, seed?: Partial<SessionKeyState>): SessionKeyState {
  const key = sliceKeyFor(site)
  const current = $sessionKeyStates.get()[key]

  if (current) {
    return current
  }

  const scope = 'draftKey' in site ? null : site.ref

  return publishSessionState(key, {
    ...emptySessionState(seed?.storedSessionId ?? (scope ? scope.storedSessionId : null)),
    ...(scope ? { connectionId: scope.connectionId, profile: scope.profile } : {}),
    ...seed
  })
}

/** THE per-session write path: apply an updater to one session's slice and
 *  publish it. Creates the slice when absent — the previous version returned
 *  `undefined` cast to a state, a latent crash the moment the visible chat
 *  started reading from the map. Mirrors desktop's `updateSession`. */
export function updateSession(
  key: string,
  updater: (state: SessionKeyState) => SessionKeyState
): SessionKeyState {
  // A slice created here inherits the KEY's scope, which `publishSessionState`
  // would enforce anyway — this is the one path that reaches a key without a
  // site, because it is a write to a session that should already exist.
  const current = $sessionKeyStates.get()[key] ?? ensureSessionSlice(siteOfKey(key))
  const next = updater(current)

  return next === current ? current : publishSessionState(key, next)
}

/**
 * Move a slice from one key to another in ONE `$sessionKeyStates.set`, so no
 * subscriber ever observes a frame where the session exists under neither key.
 * If the moving slice is the active one, `$activeSessionKey` follows in the same
 * tick.
 *
 * This is the draft→runtime and hydrating→runtime primitive. Callers must invoke
 * it synchronously once the gateway hands back a runtime id, before awaiting
 * anything else: the event router drops events for unknown keys, so the slice
 * has to exist under its real id before the first streamed event for it arrives.
 */
export function rekeySession(fromKey: string, toKey: string, patch?: Partial<SessionKeyState>): SessionKeyState {
  // THE ONE SEAM the seven rekey sites inherit their scope through (invariant
  // 45). A rekey moves a session onto a fresh runtime id — a not-found
  // recovery, a resume rotation — and the session does not change connection by
  // being re-keyed, so the outgoing slice's scope comes with it. Where the
  // target key names a scope of its own, `publishSessionState` has the last
  // word: the key is the address.
  const outgoing = $sessionKeyStates.get()[fromKey]

  // The seven rekey sites hand over the RUNTIME ID the wire gave them — a
  // not-found recovery, a resume rotation, a draft taking its issued id — and
  // the seam mints the key, so none of them has to remember the scope. A target
  // that is already a key (`@conn|id`, or a placeholder) is left alone.
  if (outgoing?.connectionId && !isPlaceholderKey(toKey) && !isScopedKey(toKey)) {
    toKey = runtimeKeyFor(outgoing.connectionId, toKey)
  }

  // …and where the caller DID name a scope, it has to agree: a rekey across
  // connections would be a session handed to another backend, which is not a
  // thing that happens. The named key wins — it is the address — but silently
  // would leave a slice nobody could explain.
  const target = isPlaceholderKey(toKey) ? null : parseSessionKey(toKey)

  if (outgoing?.connectionId && target && target.connectionId !== outgoing.connectionId) {
    console.warn('[sessions] refusing a rekey across connections', {
      from: outgoing.connectionId,
      fromKey,
      to: target.connectionId,
      toKey
    })
  }

  const inherited: Partial<SessionKeyState> =
    outgoing?.connectionId && !patch?.connectionId
      ? { connectionId: target?.connectionId ?? outgoing.connectionId, profile: patch?.profile ?? outgoing.profile }
      : {}

  patch = { ...inherited, ...patch }

  // Anything queued under the old key is this session's own output, so apply it
  // before the move rather than letting the teardown below discard it.
  flushDeltas(fromKey)

  const states = $sessionKeyStates.get()
  const moving = states[fromKey] ?? emptySessionState()

  if (fromKey === toKey) {
    return publishSessionState(toKey, { ...moving, ...patch })
  }

  const prevAtTarget = states[toKey] ?? null
  const next = { ...moving, ...patch, lastTouchedAt: Date.now() }
  const { [fromKey]: _moved, ...rest } = states

  // BEFORE the publish, not after. The reverse index is not an atom — it is a
  // plain map that subscribers CONSULT while they react to the publish, and
  // `$sessionKeyStates.set` notifies synchronously. Remapping afterwards meant
  // every `runtimeKeyForStoredSession` call made from inside that notification
  // resolved the stored id to the OLD key, found it missing from the map it had
  // just been handed, and took the self-healing branch — which DELETES the index
  // entry. The remap below then had nothing left to move, and although
  // `indexStoredId` re-seeded the entry a statement later, the damage was
  // already done: `tileRuntimeKey` / `bubbleRuntimeKey` / `$focusedRuntimeId`
  // are memoized computeds, so each one had already latched its fallback (a
  // tile's cached `runtimeId`, i.e. the DEAD key) and would not recompute until
  // some unrelated write touched the map again. A tile recovered while idle
  // therefore went blank — the promise this function is named for, "no
  // subscriber ever observes a frame where the session exists under neither
  // key", held for the map and not for the index that addresses it (MJXHRM-308).
  //
  // Nothing observes the window between these two statements: neither writes an
  // atom, so there is no notification to run a reader in it.
  remapStoredIdIndex(fromKey, toKey)
  indexStoredId(prevAtTarget, next, toKey)

  $sessionKeyStates.set({ ...rest, [toKey]: next })

  fireSessionKeyHook(hooks => hooks.rekey(fromKey, toKey, moving))

  if ($activeSessionKey.get() === fromKey) {
    $activeSessionKey.set(toKey)
  }

  disposeHook?.(fromKey, moving)
  transitionHook?.(prevAtTarget, next, toKey)

  return next
}

/** Evict a session's slice entirely. */
export function dropSessionState(key: string): void {
  const current = $sessionKeyStates.get()

  if (!(key in current)) {
    return
  }

  const state = current[key]
  dropStoredIdIndexFor(key)

  const { [key]: _dropped, ...rest } = current
  $sessionKeyStates.set(rest)
  fireSessionKeyHook(hooks => hooks.drop(key))
  disposeHook?.(key, state)
}
