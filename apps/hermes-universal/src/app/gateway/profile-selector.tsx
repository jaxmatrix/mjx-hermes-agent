import { useEffect } from 'react'

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useStore } from '@/store/atom'
import { $connection, connectLocal } from '@/store/connection'
import { $gatewayMode } from '@/store/gateway-switch'
import { notify } from '@/store/notifications'
import { $activeProfile, $profiles, refreshProfiles, setActiveProfile } from '@/store/profiles'

// Active-profile selector (E7.c). Switching re-scopes REST (config/skills/model/
// sessions) immediately, then prompts a session refresh so the running chat picks
// it up — mode-aware: local can fully apply it by respawning the backend; a shared
// remote/cloud gateway can only re-scope REST (the chat runs the gateway's own
// profile — a backend limit), so we say so instead of pretending.

// Radix Select disallows empty-string values; use a sentinel for "the gateway's
// own (primary) profile".
const OWN = '__own__'

export function ProfileSelector() {
  const profiles = useStore($profiles)
  const active = useStore($activeProfile)
  const mode = useStore($gatewayMode)
  const connection = useStore($connection)

  useEffect(() => {
    void refreshProfiles()
  }, [])

  function onChange(value: string): void {
    const target = value === OWN ? null : value

    if (target === active) {
      return
    }

    setActiveProfile(target)

    if (!connection) {
      return
    }

    const name = target ? `"${target}"` : 'the default profile'

    if (mode === 'local') {
      notify({
        kind: 'info',
        message: `Restart the backend as ${name} to apply it to chat?`,
        action: { label: 'Restart', onClick: () => void connectLocal(target) }
      })
    } else {
      notify({
        kind: 'info',
        message: `Settings and skills now use ${name}. The live chat still runs the gateway's own profile.`
      })
    }
  }

  return (
    <Select onValueChange={onChange} value={active ?? OWN}>
      <SelectTrigger className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={OWN}>Default (primary)</SelectItem>
        {profiles.map(p => (
          <SelectItem key={p.name} value={p.name}>
            {p.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
