import { Container } from '@/components/layout/container'
import { Stack } from '@/components/layout/stack'

import { SidebarTrigger } from './sidebar'

// Stand-in for a not-yet-ported view so the nav is fully navigable. Each mapped
// route in mobile-controller carries a FIXME(<track>) for its real screen.
export function PlaceholderView({ title }: { title: string }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b border-border p-3">
        <SidebarTrigger className="md:hidden" />
        <h1 className="text-base font-semibold text-foreground">{title}</h1>
      </header>
      <Container className="flex-1 py-[clamp(1.5rem,5vw,4rem)]" size="prose">
        <Stack align="center" gap={2}>
          <p className="text-muted-foreground">{title} isn’t ported to mobile yet.</p>
        </Stack>
      </Container>
    </div>
  )
}
