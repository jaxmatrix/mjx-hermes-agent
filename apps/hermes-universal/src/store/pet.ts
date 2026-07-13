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
