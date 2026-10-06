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

  it('refuses ports other than 80 and 443 on every hop when asked (#96 review S5)', async () => {
    const web = { ...options, webPortsOnly: true }
    for (const url of ['https://a.example:8443/', 'http://a.example:22/']) {
      const fetcher = routedFetch({ [url]: text('ok') })
      expect(await safeFetch(url, { ...web, fetcher }), url).toEqual({
        code: 'invalid_target',
        ok: false
      })
      expect(fetcher.calls).toEqual([])
      // Without the option (submit v2's checks, local fixtures), any port is fetched.
      expect(
        await safeFetch(url, { ...options, fetcher: routedFetch({ [url]: text('ok') }) })
      ).toMatchObject({ ok: true })
    }
    const fetcher = routedFetch({
      'https://a.example/': redirect('https://a.example:6379/'),
      'https://a.example/b': text('ok')
    })
    expect(await safeFetch('https://a.example/', { ...web, fetcher })).toEqual({
      code: 'invalid_target',
      ok: false
    })
    expect(await safeFetch('https://a.example:443/b', { ...web, fetcher })).toMatchObject({
      ok: true
    })
  })

  it('reads the response type as Fetch does: the last valid of repeated headers', async () => {
    const typed = (contentType: string) =>
      safeFetch('https://a.example/', {
        ...options,
        fetcher: routedFetch({
          'https://a.example/': new Response('ok', { headers: { 'Content-Type': contentType } })
        })
      })
    expect(await typed('text/plain, text/plain')).toMatchObject({ contentType: 'text/plain' })
    expect(await typed('text/html, Text/Plain; charset=utf-8')).toMatchObject({ ok: true })
    expect(await typed('text/plain, text/html')).toEqual({ code: 'unexpected_type', ok: false })
    expect(await typed('text/plain; a="x, text/html"')).toMatchObject({ ok: true })
  })
})
