import { Codecs, persistentAtom } from '@/lib/persisted'

// Whether a relaunch paints the last conversation behind the connecting screen
// (MJXHRM-480). ON by default: the alternative is a spinner for the length of a
// dial that can be a WAN round trip, a 45-90 s SSH spawn, or — offline — forever.
//
// A device-local pref, so `persistentAtom`/localStorage beside $introSplash and
// the other Appearance switches, NOT the gateway config schema: nothing here is
// sent anywhere, and a phone and a workstation talking to one gateway are
// allowed to disagree about it.
//
// It is also the whole feature's off switch — a mobile layout that turns out
// wrong is one toggle away from today's behaviour.
export const $restorePaintEnabled = persistentAtom<boolean>('hermes.restorePaint', true, Codecs.bool)

export const setRestorePaintEnabled = (on: boolean) => $restorePaintEnabled.set(on)
