import type { ComponentType, Dispatch, SetStateAction } from 'react'

import type { EnvVarInfo } from '@/types/hermes'

// Ported (trimmed) from apps/desktop/src/app/settings/types.ts. The desktop
// overlay-only `SettingsPageProps`/`HermesGateway` bits are dropped; the icon is
// typed structurally instead of via the desktop `IconComponent` alias.

export type EnvPatch = Partial<Pick<EnvVarInfo, 'is_set' | 'redacted_value'>>

export interface ProviderGroup {
  name: string
  priority: number
  entries: [string, EnvVarInfo][]
  hasAnySet: boolean
}

export interface DesktopConfigSection {
  id: string
  label: string
  icon: ComponentType<{ className?: string }>
  keys: string[]
}

export interface EnvRowProps {
  varKey: string
  info: EnvVarInfo
  edits: Record<string, string>
  revealed: Record<string, string>
  saving: string | null
  setEdits: Dispatch<SetStateAction<Record<string, string>>>
  onSave: (key: string) => void
  onClear: (key: string) => void
  onReveal: (key: string) => void
  compact?: boolean
}
