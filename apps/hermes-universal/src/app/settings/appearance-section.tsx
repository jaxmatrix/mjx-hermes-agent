import { LanguageSwitcher } from '@/components/language-switcher'
import { ThemeControls } from '@/components/theme-picker'
import { useI18n } from '@/i18n'

import { SettingsContent } from './primitives'

// Appearance (Jc8): the theme engine's mode + skin controls, plus the language
// switcher. Desktop-only bits (UI scale/zoom, window translucency, inline-embed
// consent, tool-view display, VS Code marketplace theme install) are omitted or
// deferred — FIXME(J8).
export function AppearanceSection() {
  const { t } = useI18n()

  return (
    <SettingsContent>
      <div className="pt-3">
        <ThemeControls />
      </div>
      <div className="mt-6">
        <div className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">{t.language.label}</div>
        <LanguageSwitcher />
      </div>
    </SettingsContent>
  )
}
