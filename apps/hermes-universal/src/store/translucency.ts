/**
 * Window translucency — the webview owns the preference, Rust owns the levers.
 *
 * The persisted value is a `TranslucencyBook` (a global mode plus per-appearance
 * intensity / fade / material / scope); everything downstream is handed the
 * RESOLVED `TranslucencyState` for the appearance actually painted. What each OS
 * can do is not guessed: `appearance_capabilities` is asked once per WebView and
 * the settings rows follow its answer, not `IS_DESKTOP`.
 *
 * Three coalescers on one change, and they are not the same:
 *  - the PAGE repaints per tick, because that is the effect;
 *  - the NATIVE half is sent only when it actually differs, so a tint drag under
 *    glass — where the lever is a CSS colour — costs zero IPC and zero native
 *    calls across ~100 ticks;
 *  - storage and the peer broadcast ride a 120 ms trailing timer.
 *
 * `hermes.translucency.v2` is the key. The bare-number `hermes.translucency`
 * migrates into `base` (so BOTH appearances inherit what was already tuned) and
 * is then left alone — three bytes, and the downgrade path.
 */

import type * as TauriCore from '@tauri-apps/api/core'

import { applyGlassSurfaces } from '@/lib/glass-surfaces'
import { readKey } from '@/lib/persist'
import { IS_MAC, IS_TAURI, PLATFORM } from '@/lib/platform'
import { readJson, writeJson } from '@/lib/storage'
import type { Support } from '@/lib/surface'
import {
  clampIntensity,
  glassActive,
  type GlassMaterial,
  type GlassScope,
  normalizeBook,
  resolveTranslucency,
  setTranslucencyValues,
  type TranslucencyBook,
  type TranslucencyMode,
  type TranslucencyState,
  type TranslucencyValues,
  windowOpacityFor
} from '@/lib/translucency-model'
import { broadcastToPeers, onPeerBroadcast, type PeerBroadcast } from '@/lib/webview-broadcast'
import { atom, computed, keepMount } from '@/store/atom'
import { isGlassBackedWindow } from '@/store/windows'

export const TRANSLUCENCY_KEY = 'hermes.translucency.v2'
/** The 0–100 number this replaced. Never written again; never deleted either. */
const LEGACY_KEY = 'hermes.translucency'

/** Cross-WebView adoption. Nothing else should use this event name. */
export const TRANSLUCENCY_EVENT = 'translucency://changed'

const WRITE_DEBOUNCE_MS = 120
/** A frost/area/mode click has no drag to hold the preview open. */
const PEEK_PULSE_MS = 900

const IS_WINDOWS = PLATFORM === 'windows'

/** What `appearance_capabilities` answers. Mirrors `appearance/mod.rs`. */
export interface AppearanceCapabilities {
  platform: string
  translucency: Support
  glass: Support
  materials: GlassMaterial[]
  osBuild: null | number
  notes: string[]
}

export type GlassStep = 'applied' | 'cleared' | 'failed' | 'unchanged' | 'unsupported'

/** What `appearance_set_glass` answers. Mirrors `appearance/mod.rs`. */
export interface GlassOutcome {
  material: GlassStep
  opacity: GlassStep
  /** What the window carries RIGHT NOW — believed over this window's own ask. */
  effectiveGlass: boolean
  note: null | string
}

/**
 * A guess, and the only one in this file: whether glass is likely available,
 * used to decide what the FIRST frame paints. Corrected by the capability answer
 * within the first few frames. Awaiting Rust instead would put an IPC round trip
 * in front of every window's first paint for a cosmetic setting.
 */
const OPTIMISTIC_GLASS = IS_MAC || IS_WINDOWS

function legacyPayload(): unknown {
  const raw = readKey(LEGACY_KEY)

  return raw === null ? null : { intensity: clampIntensity(Number(raw)) }
}

export const $translucencyBook = atom<TranslucencyBook>(
  normalizeBook(readJson<unknown>(TRANSLUCENCY_KEY) ?? legacyPayload(), OPTIMISTIC_GLASS)
)

/**
 * The appearance actually PAINTED, published by `applyTheme` — not the user's
 * light/dark preference. A skin that keeps a bright background while the
 * preference says dark resolves as light, because the tint has to answer to the
 * pixels rather than to the preference.
 */
export const $glassAppearance = atom<'dark' | 'light'>('dark')

export function setGlassAppearance(appearance: 'dark' | 'light'): void {
  if ($glassAppearance.get() !== appearance) {
    $glassAppearance.set(appearance)
  }
}

export const $glassCapabilities = atom<AppearanceCapabilities | null>(null)

/** True while a translucency control is held — the Settings overlay ghosts. */
export const $translucencyPeek = atom(false)

/**
 * The resolved state, computed on demand.
 *
 * This module reads it from its own non-React hot path (the paint and the native
 * push) and a nanostores `computed` is LAZY — with no live subscriber it can
 * hand back the value from before the edit that just happened. Resolving is a
 * pure object build over four keys, so the store calls this and leaves the atom
 * below to the components.
 */
function resolved(): TranslucencyState {
  return resolveTranslucency($translucencyBook.get(), $glassAppearance.get(), IS_WINDOWS)
}

/** The resolved state. THE thing handed around; the book stays in here. */
export const $translucency = computed([$translucencyBook, $glassAppearance], (book, appearance): TranslucencyState =>
  resolveTranslucency(book, appearance, IS_WINDOWS)
)

// Live for the life of the process, so a `.get()` from outside React is never
// the stale value a lazy computed would hand back.
keepMount($translucency)

/** Whether the translucency rows may be offered at all on this device. */
export function translucencyAvailable(caps: AppearanceCapabilities | null): boolean {
  return caps !== null && caps.translucency !== 'unsupported'
}

/** Whether the glass MODE (and the frost / area / fade rows) may be offered. */
export function glassAvailable(caps: AppearanceCapabilities | null): boolean {
  return caps?.glass === 'supported'
}

// ── the native half ─────────────────────────────────────────────────────────

type NativeHalf = Pick<TranslucencyState, 'fade' | 'intensity' | 'material' | 'mode'>

function nativeHalf(state: TranslucencyState): NativeHalf {
  return { fade: state.fade, intensity: state.intensity, material: state.material, mode: state.mode }
}

/**
 * What the levers actually DECIDE, which is the only thing worth an IPC.
 *
 * The mirror of Rust's `changed()`: the mode, whether glass is ACTIVE (not what
 * the tint happens to be), the frost rung, and the resolved window opacity. So a
 * tint drag under glass — where the lever is a CSS colour and reaches nothing
 * native — sends one message across ~100 ticks, the one that crosses zero, while
 * a drag under clear sends every tick because there the lever IS the opacity.
 *
 * `scope` is absent on purpose: it moves no native property at all, so changing
 * it must cost nothing.
 */
function nativeSignature(state: TranslucencyState): string {
  return [state.mode, glassActive(state), state.material, windowOpacityFor(state)].join('|')
}

let lastSent: null | string = null
/** Only the newest push may write an outcome back, so a slow refusal cannot
 *  undo a later success (`store/keep-awake.ts:42` shape). */
let generation = 0
/** The material this window actually carries, per Rust. Starts optimistic so the
 *  first paint is not a flash of opaque. */
let effectiveGlass = true
let degradeLogged = false

/**
 * The Tauri core module, imported once.
 *
 * A clear-mode drag pushes per tick, and `import()` per tick would ask the
 * module graph the same question a hundred times over one gesture.
 */
let core: null | Promise<typeof TauriCore> = null

function tauriCore(): Promise<typeof TauriCore> {
  core ??= import('@tauri-apps/api/core')

  return core
}

export async function applyGlass(half: NativeHalf): Promise<GlassOutcome> {
  const { invoke } = await tauriCore()

  return await invoke<GlassOutcome>('appearance_set_glass', { state: half })
}

function pushNative(state: TranslucencyState, force = false): void {
  if (!IS_TAURI || !isGlassBackedWindow()) {
    return
  }

  const signature = nativeSignature(state)

  if (!force && lastSent === signature) {
    return
  }

  lastSent = signature

  const mine = ++generation

  void applyGlass(nativeHalf(state))
    .then(outcome => {
      if (generation !== mine) {
        return
      }

      effectiveGlass = outcome.effectiveGlass
      degrade(outcome)
      paint()
    })
    .catch(() => {
      // No Tauri runtime, or a platform with no command at all. Cosmetic — the
      // flags simply stay off (recipe 6.2's degrade rule); never a toast.
      if (generation === mine) {
        effectiveGlass = false
        paint()
      }
    })
}

/**
 * A refusal is not an error, it is an answer. Drop to `clear` so the mode row
 * stops claiming a material this window does not have, and say why ONCE — a
 * cosmetic native failure reaches the log, never the user. The settings row is
 * what tells them, through the capability report.
 */
function degrade(outcome: GlassOutcome): void {
  if (outcome.material !== 'unsupported' && outcome.material !== 'failed') {
    return
  }

  if ($translucencyBook.get().mode === 'glass') {
    writeBook({ ...$translucencyBook.get(), mode: 'clear' })
  }

  if (!degradeLogged) {
    degradeLogged = true
    console.warn('[translucency] glass unavailable:', outcome.note ?? outcome.material)
  }
}

// ── writes ──────────────────────────────────────────────────────────────────

function paint(): void {
  applyGlassSurfaces(resolved(), { effectiveGlass, glassBacked: isGlassBackedWindow() })
}

let writeTimer: null | number = null
/**
 * Whether the pending flush may announce itself.
 *
 * Structural, not a heuristic (`themes/appearance-sync.ts:41` shape): a book
 * adopted FROM a peer is never broadcast back out, so it cannot circulate. The
 * flag has to survive the 120 ms timer, which is why it is not just a boolean
 * held across the adopting call.
 */
let broadcastPending = true

interface TranslucencyChangedPayload extends PeerBroadcast {
  book: TranslucencyBook
}

function flush(): void {
  writeTimer = null

  const book = $translucencyBook.get()

  writeJson(TRANSLUCENCY_KEY, book)

  if (broadcastPending) {
    broadcastToPeers<TranslucencyChangedPayload>(TRANSLUCENCY_EVENT, { book })
  }

  broadcastPending = true
}

function writeBook(book: TranslucencyBook, adopted = false): void {
  $translucencyBook.set(book)

  paint()
  pushNative(resolved())

  if (adopted) {
    broadcastPending = false
  }

  if (writeTimer !== null) {
    clearTimeout(writeTimer)
  }

  writeTimer = setTimeout(flush, WRITE_DEBOUNCE_MS) as unknown as number
}

function patch(values: Partial<TranslucencyValues>): void {
  writeBook(setTranslucencyValues($translucencyBook.get(), $glassAppearance.get(), values))
}

export function setTranslucency(intensity: number): void {
  patch({ intensity: clampIntensity(intensity) })
}

export function setTranslucencyFade(fade: number): void {
  patch({ fade: clampIntensity(fade) })
}

export function setTranslucencyMaterial(material: GlassMaterial): void {
  patch({ material })
}

export function setTranslucencyScope(scope: GlassScope): void {
  patch({ scope })
}

export function setTranslucencyMode(mode: TranslucencyMode): void {
  writeBook({ ...$translucencyBook.get(), mode })
}

/**
 * Write a pending change now. A window closing mid-drag must not leave the
 * persisted book on the value the hand passed through 100 ms ago.
 *
 * Kept by name from MJXHRM-462 and repointed: it used to flush the native call,
 * which now goes out per change rather than on a timer.
 */
export function flushPendingTranslucency(): void {
  if (writeTimer !== null) {
    clearTimeout(writeTimer)
    flush()
  }
}

// ── peek ────────────────────────────────────────────────────────────────────

let peekHolds = 0
let peekTimer: null | number = null

function publishPeek(): void {
  const on = peekHolds > 0

  if ($translucencyPeek.get() !== on) {
    $translucencyPeek.set(on)
  }

  const element = typeof document === 'undefined' ? null : document.documentElement

  if (!element) {
    return
  }

  if (on) {
    element.dataset.hermesTranslucencyPeek = ''
  } else {
    delete element.dataset.hermesTranslucencyPeek
  }
}

export function beginTranslucencyPeek(): void {
  peekHolds += 1
  publishPeek()
}

export function endTranslucencyPeek(): void {
  // Floored at zero: a pointer held when Escape closes the overlay never
  // delivers its `pointerup`, and a counter that went negative would ghost the
  // NEXT overlay for the life of the process.
  peekHolds = Math.max(0, peekHolds - 1)
  publishPeek()
}

/** A click has no hold, so preview it for a beat instead. */
export function pulseTranslucencyPeek(): void {
  beginTranslucencyPeek()

  if (peekTimer !== null) {
    clearTimeout(peekTimer)
  }

  peekTimer = setTimeout(() => {
    peekTimer = null
    endTranslucencyPeek()
  }, PEEK_PULSE_MS) as unknown as number
}

/** Every hold released — what unmounting the settings surface must call. */
export function resetTranslucencyPeek(): void {
  if (peekTimer !== null) {
    clearTimeout(peekTimer)
    peekTimer = null
  }

  peekHolds = 0
  publishPeek()
}

// ── boot ────────────────────────────────────────────────────────────────────

/**
 * Ask the platform what it can do, and correct the optimistic guess.
 *
 * Fire-and-forget with no timeout: it cannot block anything, and a hung IPC
 * simply leaves the guess in place.
 */
async function loadCapabilities(): Promise<void> {
  if (!IS_TAURI) {
    return
  }

  const { invoke } = await tauriCore()
  const caps = await invoke<AppearanceCapabilities>('appearance_capabilities')

  $glassCapabilities.set(caps)

  const book = $translucencyBook.get()
  const corrected = normalizeBook(book, glassAvailable(caps))

  if (corrected.mode !== book.mode) {
    // Not an edit — the platform never had this mode — so nothing is persisted
    // here; the next real edit writes the corrected book.
    $translucencyBook.set(corrected)
  }

  paint()
}

/**
 * Push the persisted preference down once at startup, for THIS window.
 *
 * Called from `main.tsx` beside `initKeepAwake()` / `initDataUrlReadMax()`. The
 * native lever dies with the process, so without this a user who set 40 % gets a
 * fully opaque window on every relaunch until they touch the slider.
 */
export function initTranslucency(): void {
  pushNative(resolved(), true)
}

/** Test seam: forget what this module has sent and been told. */
export function __resetTranslucencyNativeState(): void {
  lastSent = null
  generation = 0
  effectiveGlass = true
  degradeLogged = false
  broadcastPending = true

  if (writeTimer !== null) {
    clearTimeout(writeTimer)
    writeTimer = null
  }
}

// The first paint is already correct: no flash of an opaque window that then
// goes translucent. `themes/context.tsx` publishes the rendered appearance at
// import time, and it is imported before any component.
paint()
void loadCapabilities().catch(() => {})

$glassAppearance.listen(() => {
  // An appearance switch is not an EDIT: the book is not written, only
  // re-resolved and re-applied.
  paint()
  pushNative(resolved())
})

onPeerBroadcast<TranslucencyChangedPayload>(TRANSLUCENCY_EVENT, payload => {
  // Adopt, re-resolve, repaint, and push THIS window's own native state — but
  // never re-announce, or two windows would trade the same book forever.
  writeBook(normalizeBook(payload.book, glassAvailable($glassCapabilities.get()) || OPTIMISTIC_GLASS), true)
})

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushPendingTranslucency)
}
