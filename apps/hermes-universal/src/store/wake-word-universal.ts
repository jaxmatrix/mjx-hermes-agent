/** Universal wake routing types — not in desktop AUTO `wake-word.ts`. */
export interface WakeDetection {
  phrase?: string
  profile?: string | null
  startNewSession?: boolean
}
