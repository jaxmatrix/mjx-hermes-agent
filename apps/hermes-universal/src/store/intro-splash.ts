import { Codecs, persistentAtom } from '@/lib/persisted'

// Whether the wordmark + tagline splash renders on an empty chat (desktop
// `store/intro-splash.ts`). On by default, matching desktop — it is the app's
// first impression, and someone who wants the bare composer says so once.
//
// A device-local pref, so `persistentAtom`/localStorage beside $backdrop and the
// other Appearance switches, NOT the gateway config schema: nothing here is sent
// anywhere, and a phone and a workstation talking to one gateway are allowed to
// disagree about a decoration.
export const $introSplash = persistentAtom<boolean>('hermes.introSplash', true, Codecs.bool)

export const setIntroSplash = (on: boolean) => $introSplash.set(on)
