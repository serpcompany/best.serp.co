import { describe, expect, it } from 'vitest'
import { routedFetch } from './media-test-support'
import { SAFE_FETCH_MAX_REDIRECTS, safeFetch } from './safe-fetch'

const options = {
  accept: (type: string) => type === 'text/plain',
  acceptHeader: 'text/plain',
  maxBytes: 16
}
const redirect = (location: string) =>
  new Response(null, { headers: { Location: location }, status: 301 })
const text = (body: string) => new Response(body, { headers: { 'Content-Type': 'text/plain' } })

describe('safeFetch', () => {
  it('follows a bounded number of redirects, checking every hop', async () => {
    const hops = Array.from(
      { length: SAFE_FETCH_MAX_REDIRECTS + 2 },
      (_, index) => `https://hop${index}.example/`
    )
    const routes = Object.fromEntries(
      hops.map((hop, index) => [hop, redirect(hops[index + 1] ?? '')])
    )
    expect(await safeFetch(hops[0] ?? '', { ...options, fetcher: routedFetch(routes) })).toEqual({
      code: 'too_many_redirects',
      ok: false
    })
    const fetcher = routedFetch({
      'https://a.example/': redirect('/b'),
      'https://a.example/b': text('ok')
    })
    expect(await safeFetch('https://a.example/', { ...options, fetcher })).toMatchObject({
      ok: true,
      url: 'https://a.example/b'
    })
    expect(fetcher.calls).toEqual(['https://a.example/', 'https://a.example/b'])
    expect(
      await safeFetch('https://a.example/', {
        ...options,
        fetcher: routedFetch({ 'https://a.example/': redirect('http://[::1]/') })
      })
    ).toEqual({ code: 'invalid_target', ok: false })
  })

  it('refuses unexpected types and bodies over the cap, declared or streamed', async () => {
    const html = new Response('<html>', { headers: { 'Content-Type': 'text/html' } })
    expect(
      await safeFetch('https://a.example/', {
        ...options,
        fetcher: routedFetch({ 'https://a.example/': html })
      })
    ).toEqual({ code: 'unexpected_type', ok: false })
    expect(
      await safeFetch('https://a.example/', {
        ...options,
        fetcher: routedFetch({ 'https://a.example/': text('x'.repeat(17)) })
      })
    ).toEqual({ code: 'response_too_large', ok: false })
    expect(
      await safeFetch('https://a.example/', {
        ...options,
        fetcher: routedFetch({
          'https://a.example/': () => {
            throw new DOMException('t', 'TimeoutError')
          }
        })
      })
    ).toEqual({ code: 'fetch_timeout', ok: false })
  })
})
