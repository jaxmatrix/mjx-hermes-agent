import { useStore } from '@/store/atom'
import { $busy } from '@/store/chat'
import { $petInfo } from '@/store/pet'

import { PetSprite } from './pet-sprite'

// The in-app pet (K10.b): a small sprite that idles in the chat corner and
// switches to its run animation while a turn is streaming. Mobile drops the
// desktop roam physics / floating pop-out overlay — the pet stays parked.
export function FloatingPet() {
  const info = useStore($petInfo)
  const busy = useStore($busy)

  if (!info.enabled || !info.spritesheetBase64) {
    return null
  }

  return (
    <div className="pointer-events-none fixed bottom-20 right-2 z-20 opacity-90" aria-hidden>
      <PetSprite state={busy ? 'run' : 'idle'} />
    </div>
  )
}
