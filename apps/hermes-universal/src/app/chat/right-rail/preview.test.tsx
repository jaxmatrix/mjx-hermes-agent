import { render, screen } from '@testing-library/react'
import { atom } from 'nanostores'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Universal's one delta on desktop's pane host: a `url` tab is the Rust guest
// (`BrowserPane`), every other kind is desktop's `PreviewPane`, untouched.

const stores = vi.hoisted(
  () => ({}) as Record<'guest' | 'reload' | 'restart' | 'tabs', ReturnType<typeof atom<unknown>>>
)

vi.mock('@/app/browser/browser-pane', () => ({ BrowserPane: () => <div data-testid="guest" /> }))
vi.mock('./preview-pane', () => ({
  PreviewPane: (props: { onRestartServer?: unknown; tabId: string; target: { kind: string } }) => (
    <div data-kind={props.target.kind} data-restart={String(Boolean(props.onRestartServer))} data-testid="desktop">
      {props.tabId}
    </div>
  )
}))
vi.mock('@/app/contrib/panes', () => ({ $restartPreviewServer: (stores.restart = atom<unknown>(null)) }))
vi.mock('@/store/browser', () => ({ $browserGuestTabId: (stores.guest = atom<unknown>(null)) }))
vi.mock('@/store/preview', () => ({
  $previewReloadRequest: (stores.reload = atom<unknown>(0)),
  $previewTabs: (stores.tabs = atom<unknown>([]))
}))

import { PreviewTilePane } from './preview'

const tab = (id: string, target: Record<string, unknown>) => ({
  id,
  target: { label: id, source: id, url: id, ...target }
})

beforeEach(() => {
  stores.guest.set(null)
  stores.restart.set(async () => 'task')
  stores.tabs.set([
    tab('web', { kind: 'url', url: 'http://localhost:5173/' }),
    tab('web-2', { kind: 'url', url: 'https://example.test/' }),
    tab('file', { kind: 'file', path: '/w/a.ts', previewKind: 'text' }),
    tab('html', { kind: 'file', path: '/w/a.html', previewKind: 'html' }),
    tab('artifact', { kind: 'artifact' })
  ])
})

describe('PreviewTilePane', () => {
  it('renders the Rust guest for the url tab the guest is bound to, and never desktop’s <webview> pane', () => {
    stores.guest.set('web')
    render(<PreviewTilePane tabId="web" />)

    expect(screen.getByTestId('guest')).toBeInTheDocument()
    expect(screen.queryByTestId('desktop')).not.toBeInTheDocument()
  })

  // ONE live guest: a url tab that does not hold it is only a location.
  it('renders nothing for a url tab the guest is not bound to, until focus hands it over', () => {
    stores.guest.set('web')

    const { container, rerender } = render(<PreviewTilePane tabId="web-2" />)

    expect(container).toBeEmptyDOMElement()

    stores.guest.set('web-2')
    rerender(<PreviewTilePane tabId="web-2" />)

    expect(screen.getByTestId('guest')).toBeInTheDocument()
  })

  it.each(['file', 'html', 'artifact'])('renders desktop’s pane for a %s tab, with desktop’s props', tabId => {
    stores.guest.set('web')
    render(<PreviewTilePane tabId={tabId} />)

    expect(screen.getByTestId('desktop')).toHaveTextContent(tabId)
    expect(screen.getByTestId('desktop').dataset.restart).toBe('false')
    expect(screen.queryByTestId('guest')).not.toBeInTheDocument()
  })

  it('renders nothing for a tab that has closed', () => {
    const { container } = render(<PreviewTilePane tabId="gone" />)

    expect(container).toBeEmptyDOMElement()
  })
})
