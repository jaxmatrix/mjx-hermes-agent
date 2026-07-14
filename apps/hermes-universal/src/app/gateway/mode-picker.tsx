import { Cloud, Globe, Monitor } from '@/lib/icons'
import { LOCAL_MODE_SUPPORTED } from '@/lib/platform'
import { cn } from '@/lib/utils'
import { useStore } from '@/store/atom'
import type { GatewayMode } from '@/store/gateway-config'
import { $gatewayMode, switchGatewayMode } from '@/store/gateway-switch'

// 3-card gateway-mode picker (E2). Local is a desktop-only capability (a phone
// can't spawn a backend), so its card is hidden unless LOCAL_MODE_SUPPORTED.
// Remote and Cloud show on every platform. Selecting a card switches mode, which
// tears down any live connection so the mode's own connect surface can dial fresh.

interface ModeCard {
  mode: GatewayMode
  label: string
  hint: string
  Icon: typeof Globe
}

const CARDS: ModeCard[] = [
  { mode: 'local', label: 'Local', hint: 'Run a backend on this device', Icon: Monitor },
  { mode: 'cloud', label: 'Cloud', hint: 'Connect a Nous portal agent', Icon: Cloud },
  { mode: 'remote', label: 'Remote', hint: 'Point at a backend URL', Icon: Globe },
]

export function ModePicker() {
  const mode = useStore($gatewayMode)
  const cards = CARDS.filter(c => c.mode !== 'local' || LOCAL_MODE_SUPPORTED)

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Gateway mode">
      {cards.map(({ mode: m, label, hint, Icon }) => {
        const active = m === mode
        return (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => switchGatewayMode(m)}
            className={cn(
              'flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors',
              active ? 'border-primary bg-accent' : 'border-border hover:bg-accent'
            )}
          >
            <Icon size={20} className={active ? 'text-primary' : 'text-muted-foreground'} />
            <span className="text-sm font-medium">{label}</span>
            <span className="text-xs text-muted-foreground">{hint}</span>
          </button>
        )
      })}
    </div>
  )
}
