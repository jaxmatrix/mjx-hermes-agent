import { Codecs, persistentAtom } from '@/lib/persisted'
import { atom, computed } from '@/store/atom'

// The active pet's live info (spritesheet for the in-app animated sprite, K10.b).
// Populated from the `pet.info` gateway RPC.
export interface PetInfo {
  enabled: boolean
  slug?: string
  displayName?: string
  mime?: string
  spritesheetBase64?: string
  spritesheetRevision?: string
  frameW?: number
  frameH?: number
  framesPerState?: number
  framesByState?: Record<string, number>
  // Concrete Codex row counts (e.g. running-right may have 8 frames even though
  // the Hermes "run" activity state uses the in-place running row). Optional —
  // falls back to framesByState / framesPerState when absent.
  framesByRow?: Record<string, number>
  loopMs?: number
  scale?: number
  stateRows?: string[]
}

export const $petInfo = atom<PetInfo>({ enabled: false })

export const setPetInfo = (info: PetInfo) => $petInfo.set(info)

// The animated pose the sprite draws. Ported from desktop's PetState taxonomy
// (mirrors agent.pet.state) so every Codex row can come alive.
export type PetState = 'idle' | 'wave' | 'run' | 'failed' | 'review' | 'jump' | 'waiting'

/**
 * Coarse activity signals that drive the pose. Fed from `store/chat.ts` (the
 * gateway event stream + prompt/response paths) — never computed here, so this
 * store stays decoupled from the chat/gateway chain that the pet tests mock (in
 * particular we do NOT import chat `$busy`; it arrives as the `busy` flag).
 *
 * - `busy` / `reasoning` / `toolRunning`: steady in-turn flags set + cleared by
 *   the stream.
 * - `awaitingInput`: a clarify/approval question is blocking on the user.
 * - `error` / `greeting`: transient reaction beats fired via `flashPetActivity`
 *   (crying on failure; waving on app-open / new-chat), auto-decaying back.
 */
export interface PetActivity {
  busy?: boolean
  awaitingInput?: boolean
  toolRunning?: boolean
  reasoning?: boolean
  error?: boolean
  greeting?: boolean
}

export const $petActivity = atom<PetActivity>({})

/** Merge steady flags into the activity atom (leaves siblings intact). */
export const setPetActivity = (next: Partial<PetActivity>) => $petActivity.set({ ...$petActivity.get(), ...next })

let flashTimer: ReturnType<typeof setTimeout> | undefined

/**
 * Fire a transient reaction beat (`error` / `greeting`) that decays back to the
 * steady state after `ms`. Each beat first clears its siblings so a stale one
 * can't win the priority race in `derivePetState` (e.g. a lingering `error`
 * outranking a fresh `greeting`).
 */
export const flashPetActivity = (next: Partial<PetActivity>, ms = 1600) => {
  setPetActivity({ error: false, greeting: false, ...next })
  clearTimeout(flashTimer)
  flashTimer = setTimeout(() => setPetActivity({ error: false, greeting: false }), ms)
}

/**
 * Resolve the animation state from coarse activity signals. Priority (highest
 * first) mirrors desktop `derivePetState` (adapted: `celebrate`/`justCompleted`
 * collapse into `greeting`, since universal only waves on app-open/new-chat):
 * error → greeting → awaitingInput → toolRunning → reasoning → busy → idle.
 * `awaitingInput` outranks the in-flight signals because the turn is paused on
 * the user, not working.
 */
export function derivePetState(activity: PetActivity): PetState {
  if (activity.error) {
    return 'failed'
  }

  if (activity.greeting) {
    return 'wave'
  }

  if (activity.awaitingInput) {
    return 'waiting'
  }

  if (activity.toolRunning) {
    return 'run'
  }

  if (activity.reasoning) {
    return 'review'
  }

  if (activity.busy) {
    return 'run'
  }

  return 'idle'
}

// Roam (autonomous wander), ported from desktop store/pet.ts.
// - `$petRoam` is the opt-in toggle (persisted per-device).
// - `$petMotion` / `$petRoamDir` are published by the roam loop (use-pet-roam) to
//   drive the sprite's pose + facing without a prop change.
// (The "at rest" gate lives in FloatingPet — computed from chat `$busy` there —
// so this store stays decoupled from the gateway/chat chain that pet tests mock.)
export type PetMotion = 'run' | 'jump'

export const $petRoam = persistentAtom<boolean>('hermes.pet-roam', true, Codecs.bool)
export const setPetRoam = (on: boolean) => $petRoam.set(on)

export const $petMotion = atom<PetMotion | null>(null)
export const $petRoamDir = atom<-1 | 0 | 1>(0)

/**
 * The live pose the sprite draws. Activity always wins; only when the agent is
 * at rest (base `idle`) does a roam pose (walking → `run`, hopping/falling →
 * `jump`) show through — so the wander reads as deliberate movement and a
 * drop-from-height plays the jump pose. (`PetMotion` values are a subset of
 * `PetState`, so the fold is type-safe.)
 */
export const $petState = computed([$petActivity, $petMotion], (activity, motion): PetState => {
  const base = derivePetState(activity)

  return base === 'idle' && motion ? motion : base
})
