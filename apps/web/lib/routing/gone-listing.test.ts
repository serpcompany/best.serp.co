import { describe, expect, it, vi } from 'vitest'
import { GONE_RENDER_HEADER, listingSlugFromPath, withGoneListing } from './gone-listing'

const ORIGIN = 'https://best.serp.co'

describe('410 for unpublished listings (#64)', () => {
  it('reads the slug of a listing page only', () => {
    expect(listingSlugFromPath('/products/brieflow.ai/')).toBe('brieflow.ai')
    expect(listingSlugFromPath('/products/caf%C3%A9.example/')).toBe('café.example')
    for (const path of [
      '/products/',
      '/products/categories/',
      '/products/brieflow.ai',
      '/products/brieflow.ai/reviews/',
      '/products/%E0%A4%A/',
      '/about/'
    ]) {
      expect(listingSlugFromPath(path), path).toBeNull()
    }
  })

  it('renders the gone page with 410 when a listing page 404s and the slug is unpublished', async () => {
    const render = vi.fn(async (request: Request) => {
      expect(request.headers.get(GONE_RENDER_HEADER)).toBe('1')
      expect(request.headers.get('accept')).toBe('text/html')
      return new Response('<h1>Brieflow is no longer listed</h1>', {
        headers: { 'content-type': 'text/html' },
        status: 200
      })
    })
    const isUnpublished = vi.fn(async () => true)
    const request = new Request(`${ORIGIN}/products/brieflow.ai/`, {
      headers: { accept: 'text/html' }
    })
    const response = await withGoneListing(request, new Response('not found', { status: 404 }), {
      isUnpublished,
      render
    })
    expect(response.status).toBe(410)
    expect(response.statusText).toBe('Gone')
    expect(response.headers.get('content-type')).toBe('text/html')
    expect(await response.text()).toContain('no longer listed')
    expect(isUnpublished).toHaveBeenCalledWith('brieflow.ai')
  })

  it('leaves every other answer alone', async () => {
    const render = vi.fn()
    const notFound = () => new Response('not found', { status: 404 })
    const cases: Array<[Request, Response, boolean]> = [
      [new Request(`${ORIGIN}/products/brieflow.ai/`), new Response('ok', { status: 200 }), true],
      [new Request(`${ORIGIN}/products/never.example/`), notFound(), false],
      [new Request(`${ORIGIN}/about/`), notFound(), true],
      [new Request(`${ORIGIN}/products/brieflow.ai/`, { method: 'POST' }), notFound(), true]
    ]
    for (const [request, response, unpublished] of cases) {
      const answer = await withGoneListing(request, response, {
        isUnpublished: async () => unpublished,
        render
      })
      expect(answer).toBe(response)
    }
    // A failed lookup or a failed second render keeps the 404.
    const original = notFound()
    expect(
      await withGoneListing(new Request(`${ORIGIN}/products/x.example/`), original, {
        isUnpublished: async () => {
          throw new Error('D1 down')
        },
        render
      })
    ).toBe(original)
    const again = notFound()
    expect(
      await withGoneListing(new Request(`${ORIGIN}/products/x.example/`), again, {
        isUnpublished: async () => true,
        render: async () => new Response('error', { status: 500 })
      })
    ).toBe(again)
    expect(render).not.toHaveBeenCalled()
  })
})
