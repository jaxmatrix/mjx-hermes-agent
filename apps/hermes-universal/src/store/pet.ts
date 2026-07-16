import { Codecs, persistentAtom } from '@/lib/persisted'
import { atom } from '@/store/atom'

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
  loopMs?: number
  scale?: number
  stateRows?: string[]
}

export const $petInfo = atom<PetInfo>({ enabled: false })

export const setPetInfo = (info: PetInfo) => $petInfo.set(info)

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
