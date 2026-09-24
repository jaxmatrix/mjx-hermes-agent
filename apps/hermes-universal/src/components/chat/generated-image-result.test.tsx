import { render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

/**
 * A generated image lands on the GATEWAY's disk (`~/.hermes/cache/images/…`), so
 * the only way this renderer can paint it is over the authenticated Rust
 * transport. Pointing `<img>` at the gateway's `/api/files/download` URL instead
 * put an unauthenticated request on the wire: behind a gated gateway it comes
 * back 401 (nothing outside the transport can sign it — `?token=` exists only in
 * token mode, and the SameSite=Lax session cookie is never sent on a cross-site
 * subresource), `onError` fires, and this component renders `null`. A successful
 * generation therefore showed NOTHING in the transcript while the file sat in
 * the cache folder — the failure these tests exist to keep out.
 */

const DATA_URL = 'data:image/png;base64,Ynl0ZXM='
const readFileDataUrl = vi.fn(async (_path: string) => DATA_URL)

const { GeneratedImage } = await import('./generated-image-result')

const GATEWAY_PATH = '/Users/me/.hermes/cache/images/gen-1.png'

function renderImage(props: ComponentProps<typeof GeneratedImage>) {
  return render(
    <I18nProvider>
      <GeneratedImage {...props} />
    </I18nProvider>
  )
}

beforeEach(() => {
  readFileDataUrl.mockClear()
  readFileDataUrl.mockResolvedValue(DATA_URL)
  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true,
    value: { readFileDataUrl }
  })
})

afterEach(() => {
  delete (window as { hermesDesktop?: unknown }).hermesDesktop
})

describe('GeneratedImage', () => {
  it('paints a gateway-local image through the authenticated fs bridge', async () => {
    renderImage({ result: { host_image: GATEWAY_PATH } })

    await waitFor(() => expect(screen.getByRole('img')).toHaveAttribute('src', DATA_URL))
    expect(readFileDataUrl).toHaveBeenCalledWith(GATEWAY_PATH)
  })

  it('leaves an inline source alone rather than asking the gateway to read it', async () => {
    renderImage({ result: { host_image: DATA_URL } })

    await waitFor(() => expect(screen.getByRole('img')).toHaveAttribute('src', DATA_URL))
    expect(readFileDataUrl).not.toHaveBeenCalled()
  })

  it('holds the pulse frame while the read is in flight, never an empty box', () => {
    // The read is async, so the first paint has no src. Showing the sized
    // placeholder is what keeps the transcript from shifting under the image.
    renderImage({ result: { host_image: GATEWAY_PATH } })

    expect(document.querySelector('[data-slot="aui_generated-image"]')).not.toBeNull()
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('renders nothing when the gateway cannot read the file', async () => {
    readFileDataUrl.mockRejectedValue(new Error('gone'))

    renderImage({ result: { host_image: GATEWAY_PATH } })

    await waitFor(() => expect(screen.getByRole('link')).toHaveTextContent(GATEWAY_PATH.split('/').pop()!))
  })
})
