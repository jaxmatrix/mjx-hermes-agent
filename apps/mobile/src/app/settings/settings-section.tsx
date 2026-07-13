import { Link, useParams } from 'react-router-dom'

import { useI18n } from '@/i18n'
import { ChevronLeft } from '@/lib/icons'

import { AboutSection } from './about-section'
import { AppearanceSection } from './appearance-section'
import { ArchivedSection } from './archived-section'
import { ConfigSection } from './config-section'
import { voiceFieldVisible } from './helpers'
import { KeysSection } from './keys-section'
import { ModelSection } from './model-section'
import { NotificationsSection } from './notifications-section'
import { EmptyState, SettingsContent } from './primitives'
import { useSettingsNav } from './settings-nav'

// The per-section body. Each Track-J chunk replaces its placeholder case with a
// real renderer (Jc8 appearance, Jc9 notifications, Jc10 keys, …).
function SectionBody({ section }: { section: string }) {
  const { t } = useI18n()

  switch (section) {
    // Schema-driven config sections (Jc4).
    case 'chat':
    case 'workspace':
    case 'safety':
    case 'advanced':
      return <ConfigSection sectionId={section} />

    // Voice (Jc5): same renderer, filtered to the active TTS/STT provider's
    // fields. FIXME(J5): the ElevenLabs voice list is static (no getElevenLabsVoices
    // fetch), so tts.elevenlabs.voice_id is a free-text field for now.
    case 'voice':
      return <ConfigSection fieldFilter={voiceFieldVisible} sectionId="voice" />

    // Memory (Jc6): schema fields only. FIXME(D2): the memory-provider OAuth
    // connect panel + per-provider config panel are deferred to the auth track.
    case 'memory':
      return <ConfigSection sectionId="memory" />

    // Model (Jc7): default-model picker + the model schema fields. MoA/auxiliary/
    // local-endpoint onboarding deferred FIXME(J7).
    case 'model':
      return <ModelSection />

    // Appearance (Jc8): theme mode + skin + language.
    case 'appearance':
      return <AppearanceSection />

    // Notifications (Jc9): native-notification prefs + haptics.
    case 'notifications':
      return <NotificationsSection />

    // Keys/credentials (Jc10): env-var management. Provider OAuth connect is D2.
    case 'keys':
      return <KeysSection />

    // Archived chats (Jc11).
    case 'archived':
      return <ArchivedSection />

    // About (Jc12): version + release notes. self-update/uninstall omitted.
    case 'about':
      return <AboutSection />

    default:
      // FIXME(J): placeholder until this section's renderer lands.
      return (
        <SettingsContent>
          <EmptyState description={t.settings.config.emptyDesc} title={t.settings.config.emptyTitle} />
        </SettingsContent>
      )
  }
}

export function SettingsSection() {
  const { section = '' } = useParams()
  const nav = useSettingsNav()
  const entry = nav.find(e => e.id === section)
  const title = entry?.label ?? section

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-1 border-b border-border p-3">
        <Link
          aria-label="Back"
          className="-ml-1 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          to="/settings"
        >
          <ChevronLeft className="size-5" />
        </Link>
        <h1 className="text-base font-semibold text-foreground">{title}</h1>
      </header>
      <SectionBody section={section} />
    </div>
  )
}
