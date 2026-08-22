// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { registry } from '@/contrib/registry'
import { TRANSCRIPT_DIRECTIVE_AREA, type TranscriptDirectiveContribution } from '@/lib/transcript-directives'

import { paragraphPlainText, TranscriptDirectiveLeaf } from './transcript-directive'

describe('paragraphPlainText', () => {
  it('passes through a plain string', () => {
    expect(paragraphPlainText('::tasks')).toBe('::tasks')
  })

  it('joins an all-string child array (streamed text chunks)', () => {
    expect(paragraphPlainText(['::preview{file=', '"a.html"}'])).toBe('::preview{file="a.html"}')
  })

  it('disqualifies paragraphs with element children', () => {
    expect(paragraphPlainText(['::tasks ', <b key="x">bold</b>])).toBeNull()
    expect(paragraphPlainText(null)).toBeNull()
    expect(paragraphPlainText([])).toBeNull()
  })
})

describe('TranscriptDirectiveLeaf', () => {
  afterEach(cleanup)

  const contribution = (over?: Partial<TranscriptDirectiveContribution>) =>
    registry.register({
      id: 'test:demo',
      area: TRANSCRIPT_DIRECTIVE_AREA,
      source: 'plugin:test',
      data: {
        name: 'demo',
        render: ({ attrs }) => <div data-testid="demo-card">{attrs.label ?? 'demo'}</div>,
        ...over
      } satisfies TranscriptDirectiveContribution
    })

  it('renders the registered component for a claimed directive', () => {
    const dispose = contribution()

    try {
      render(<TranscriptDirectiveLeaf text='::demo{label="hi"}' />)
      expect(screen.getByTestId('demo-card').textContent).toBe('hi')
    } finally {
      dispose()
    }
  })

  // Both of these register `demo` FIRST and then ask for something else. An
  // empty registry would pass either assertion without the name ever being
  // compared — the rival claim is what makes them mean anything.
  it('renders nothing for an unclaimed directive, even with another claim registered', () => {
    const dispose = contribution()

    try {
      const { container } = render(<TranscriptDirectiveLeaf text="::nobody-home" />)

      expect(container.firstChild).toBeNull()
    } finally {
      dispose()
    }
  })

  it('renders nothing for plain prose, even with a claim registered', () => {
    const dispose = contribution()

    try {
      const { container } = render(<TranscriptDirectiveLeaf text="just some text" />)

      expect(container.firstChild).toBeNull()
    } finally {
      dispose()
    }
  })

  it('picks the claim whose name matches, not the first one registered', () => {
    const disposeOther = registry.register({
      id: 'test:other',
      area: TRANSCRIPT_DIRECTIVE_AREA,
      source: 'plugin:test',
      data: {
        name: 'other',
        render: () => <div data-testid="other-card">other</div>
      } satisfies TranscriptDirectiveContribution
    })

    const dispose = contribution()

    try {
      render(<TranscriptDirectiveLeaf text='::demo{label="mine"}' />)
      expect(screen.getByTestId('demo-card').textContent).toBe('mine')
      expect(screen.queryByTestId('other-card')).toBeNull()
    } finally {
      dispose()
      disposeOther()
    }
  })

  it('contains a throwing plugin render to its own boundary', () => {
    const dispose = contribution({
      render: () => {
        throw new Error('plugin bug')
      }
    })

    try {
      render(<TranscriptDirectiveLeaf text="::demo" />)
      // The chip fallback renders the contribution id, not a dead subtree.
      expect(screen.getByRole('button')).toBeTruthy()
    } finally {
      dispose()
    }
  })

  // The half-typed-directive case. A plugin claiming `demo` must not have its
  // card flash while the model is midway through typing `::demonstrate{...}`,
  // whose every prefix — `::d`, `::de`, … `::demo` — is a legal bare directive.
  describe('streaming', () => {
    it('withholds a brace-less claim while the message is still streaming', () => {
      const dispose = contribution()

      try {
        const { container } = render(<TranscriptDirectiveLeaf streaming text="::demo" />)

        expect(container.firstChild).toBeNull()
      } finally {
        dispose()
      }
    })

    it('renders that same claim once the turn settles', () => {
      const dispose = contribution()

      try {
        render(<TranscriptDirectiveLeaf streaming={false} text="::demo" />)
        expect(screen.getByTestId('demo-card')).toBeTruthy()
      } finally {
        dispose()
      }
    })

    it('renders a BRACED directive live mid-stream — the brace ends the name', () => {
      const dispose = contribution()

      try {
        render(<TranscriptDirectiveLeaf streaming text='::demo{label="live"}' />)
        expect(screen.getByTestId('demo-card').textContent).toBe('live')
      } finally {
        dispose()
      }
    })

    it('tells the plugin the message is still streaming', () => {
      const dispose = contribution({
        render: ({ streaming }) => <div data-testid="demo-card">{String(streaming)}</div>
      })

      try {
        render(<TranscriptDirectiveLeaf streaming text="::demo{}" />)
        expect(screen.getByTestId('demo-card').textContent).toBe('true')
      } finally {
        dispose()
      }
    })
  })
})
