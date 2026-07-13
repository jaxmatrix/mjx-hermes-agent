import type { ComponentType } from 'react'

import {
  AGENTS_ROUTE,
  ARTIFACTS_ROUTE,
  COMMAND_CENTER_ROUTE,
  CRON_ROUTE,
  MESSAGING_ROUTE,
  NEW_CHAT_ROUTE,
  PROFILES_ROUTE,
  SETTINGS_ROUTE,
  SKILLS_ROUTE,
  STARMAP_ROUTE,
  type AppView
} from '@/app/routes'
import { Box, Clock, Cpu, LayoutGrid, MessageCircle, Send, Settings, Sparkles, Stars, Users } from '@/lib/icons'

export interface NavItem {
  view: AppView
  path: string
  label: string
  icon: ComponentType<{ className?: string }>
}

// The shared primary-nav item list (rail on md+, drawer on phones).
// FIXME(I1): labels are literal English — wire to i18n when the runtime lands.
export const NAV_ITEMS: NavItem[] = [
  { view: 'chat', path: NEW_CHAT_ROUTE, label: 'Chat', icon: MessageCircle },
  { view: 'agents', path: AGENTS_ROUTE, label: 'Agents', icon: Cpu },
  { view: 'skills', path: SKILLS_ROUTE, label: 'Skills', icon: Sparkles },
  { view: 'cron', path: CRON_ROUTE, label: 'Routines', icon: Clock },
  { view: 'messaging', path: MESSAGING_ROUTE, label: 'Messaging', icon: Send },
  { view: 'artifacts', path: ARTIFACTS_ROUTE, label: 'Artifacts', icon: Box },
  { view: 'starmap', path: STARMAP_ROUTE, label: 'Starmap', icon: Stars },
  { view: 'command-center', path: COMMAND_CENTER_ROUTE, label: 'Command Center', icon: LayoutGrid },
  { view: 'profiles', path: PROFILES_ROUTE, label: 'Profiles', icon: Users },
  { view: 'settings', path: SETTINGS_ROUTE, label: 'Settings', icon: Settings }
]
