import { describe, expect, it, vi } from 'vitest'

// mediaExternalUrl reads $connection; stub it so file paths resolve predictably.
vi.mock('@/lib/media', () => ({
  mediaExternalUrl: (p: string) => `https://gw/api/files/download?path=${encodeURIComponent(p)}`
}))

import type { SessionInfo, SessionMessage } from '@/types/hermes'

import { artifactKind, collectArtifactsForSession } from './artifact-utils'

const session = { id: 's1', title: 'Sess', last_active: 1000, started_at: 900 } as SessionInfo
const msg = (over: Partial<SessionMessage>): SessionMessage => ({ role: 'assistant', content: '', ...over })

describe('artifact extraction', () => {
  it('classifies values by kind', () => {
    expect(artifactKind('/tmp/out.png')).toBe('image')
    expect(artifactKind('https://x.com/a')).toBe('link')
    expect(artifactKind('/home/u/report.pdf')).toBe('file')
  })

  it('pulls a markdown image, a file path, and a link from assistant text', () => {
    const messages = [
      msg({ content: 'Here is ![chart](/tmp/chart.png) and the report at /home/u/report.pdf' }),
      msg({ content: 'See https://example.com/page for details.' })
    ]
    const found = collectArtifactsForSession(session, messages)
    const byKind = (k: string) => found.filter(a => a.kind === k).map(a => a.value)

    expect(byKind('image')).toContain('/tmp/chart.png')
    expect(byKind('file')).toContain('/home/u/report.pdf')
    expect(byKind('link')).toContain('https://example.com/page')
  })

  it('resolves a file path to the gateway download URL', () => {
    const found = collectArtifactsForSession(session, [msg({ content: '![c](/tmp/c.png)' })])
    expect(found[0].href).toBe('https://gw/api/files/download?path=%2Ftmp%2Fc.png')
  })

  it('ignores user/system messages and dedupes repeats', () => {
    const messages = [
      msg({ role: 'user', content: '/tmp/ignore.png' }),
      msg({ content: '![a](/tmp/dup.png) ![a](/tmp/dup.png)' })
    ]
    const found = collectArtifactsForSession(session, messages)
    expect(found.map(a => a.value)).toEqual(['/tmp/dup.png'])
  })
})
