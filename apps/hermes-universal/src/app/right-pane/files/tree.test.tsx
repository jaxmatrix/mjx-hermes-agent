import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { IS_MOBILE } from '@/lib/platform'

vi.mock('@/hooks/use-resize-observer', async () => {
  const { useLayoutEffect } = await import('react')

  return {
    useResizeObserver: (
      callback: (entries: readonly ResizeObserverEntry[]) => void,
      ref: { current: HTMLElement | null }
    ) => {
      useLayoutEffect(() => {
        const target = ref.current

        if (!target) {
          return
        }

        callback([
          {
            contentRect: { height: 600, width: 300 },
            target
          } as unknown as ResizeObserverEntry
        ])
      })
    }
  }
})

import { ProjectTree } from './tree'
import type { TreeNode } from './use-project-tree'

const CWD = '/repo'

const NODES: TreeNode[] = [
  { id: '/repo/docs', isDirectory: true, name: 'docs' },
  { id: '/repo/notes.md', isDirectory: false, name: 'notes.md' }
] as TreeNode[]

const COPY_PATH = 'Copy path'

function Harness({ nonce }: { nonce: number }) {
  return (
    <ProjectTree
      collapseNonce={0}
      cwd={CWD}
      data={NODES}
      key="tree"
      onActivateFile={() => {}}
      onActivateFolder={() => {}}
      onLoadChildren={() => {}}
      onNodeOpenChange={() => {}}
      // A fresh object every render, exactly as the pane hands one down.
      openState={{ ...{}, [`nonce-${nonce}`]: false }}
    />
  )
}

/** The pane above the tree, with a button that re-renders it — the shape of
 *  every real update (a git-status tick, an agent edit revalidating the tree,
 *  the sidebar resizing). */
function renderPane() {
  function Pane() {
    const [nonce, setNonce] = useState(0)

    return (
      <I18nProvider>
        <button data-testid="repaint" onClick={() => setNonce(n => n + 1)} type="button">
          repaint
        </button>
        <Harness nonce={nonce} />
      </I18nProvider>
    )
  }

  return render(<Pane />)
}

/** What a user's pointer is actually over when they right-click a row: the
 *  name itself, which bubbles up to the trigger. */
function labelFor(name: string): HTMLElement {
  return screen.getByText(name)
}

function menuItem(name: string): HTMLElement | null {
  return screen.queryByRole('menuitem', { name })
}

beforeEach(() => {
  // jsdom lays nothing out, and the tree renders a skeleton until it has a
  // measured height — so hand it one.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    bottom: 600,
    height: 600,
    left: 0,
    right: 300,
    toJSON: () => ({}),
    top: 0,
    width: 300,
    x: 0,
    y: 0
  })
  vi.stubGlobal(
    'ResizeObserver',
    class {
      callback: ResizeObserverCallback
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback
      }
      disconnect() {}
      observe(target: Element) {
        this.callback([{ contentRect: { height: 600 }, target } as unknown as ResizeObserverEntry], this as never)
      }
      unobserve() {}
    } as unknown as typeof ResizeObserver
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('ProjectTree row menus', () => {
  // `tree.tsx` renders no context-menu trigger at all when this is true, so
  // every right-click assertion below would pass vacuously on a mis-sniffed
  // desktop. Pin the branch these tests are actually about.
  it('runs on the desktop branch', () => {
    expect(IS_MOBILE).toBe(false)
  })

  it('opens the context menu on a right-click on a file row', () => {
    renderPane()

    fireEvent.contextMenu(labelFor('notes.md'))

    expect(menuItem(COPY_PATH)).toBeTruthy()
    expect(menuItem('Copy relative path')).toBeTruthy()
  })

  it('opens the context menu on a right-click on a folder row', () => {
    renderPane()

    fireEvent.contextMenu(labelFor('docs'))

    expect(menuItem(COPY_PATH)).toBeTruthy()
    expect(menuItem('Copy relative path')).toBeTruthy()
  })
})
