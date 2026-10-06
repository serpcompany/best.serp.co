import { describe, expect, it, vi } from 'vitest'
import { safeFetch } from './safe-fetch'
import { createNodeFetch, isPublicAddress } from './safe-fetch-node'

const options = {
  accept: () => true,
  acceptHeader: '*/*',
  maxBytes: 64
}

describe('safeFetch in Node (DNS-checked)', () => {
  it('refuses private, loopback, link-local, ULA, and mapped or translated addresses', () => {
    for (const address of [
      '10.0.0.1',
      '127.0.0.1',
      '169.254.169.254',
      '192.168.1.1',
      '::1',
      'fe80::1',
      'fd00::1',
      'fec0::1',
      'ff02::1',
      '::ffff:127.0.0.1',
      '::7f00:1',
      '64:ff9b::7f00:1',
      '2002:7f00:1::'
    ]) {
      expect(isPublicAddress(address), address).toBe(false)
    }
    expect(isPublicAddress('93.184.216.34')).toBe(true)
    expect(isPublicAddress('2606:2800:220:1:248:1893:25c8:1946')).toBe(true)
  })

  it('checks every hop: a public name resolving privately, or a redirect to one, is refused', async () => {
    const network = vi.fn(async (input: RequestInfo | URL) =>
      String(input) === 'https://public.example/'
        ? new Response(null, { headers: { Location: 'https://rebound.example/' }, status: 302 })
        : new Response('ok')
    )
    const addresses: Record<string, string[]> = {
      'public.example': ['93.184.216.34'],
      'rebound.example': ['10.1.2.3'],
      'localtest.me': ['127.0.0.1']
    }
    const fetcher = createNodeFetch({
      fetch: network as typeof fetch,
      resolve: async host => addresses[host] ?? []
    })
    expect(await safeFetch('https://localtest.me/', { ...options, fetcher })).toEqual({
      code: 'invalid_target',
      ok: false
    })
    expect(await safeFetch('https://public.example/', { ...options, fetcher })).toEqual({
      code: 'invalid_target',
      ok: false
    })
    expect(network.mock.calls.map(([url]) => String(url))).toEqual(['https://public.example/'])
    expect(await safeFetch('https://unknown.example/', { ...options, fetcher })).toEqual({
      code: 'invalid_target',
      ok: false
    })
  })

  it('fetches only ports 80 and 443', async () => {
    const network = vi.fn(async () => new Response('ok'))
    const fetcher = createNodeFetch({
      fetch: network as typeof fetch,
      resolve: async () => ['93.184.216.34']
    })
    expect(await safeFetch('https://example.com:6379/', { ...options, fetcher })).toEqual({
      code: 'invalid_target',
      ok: false
    })
    expect(await safeFetch('http://example.com:80/', { ...options, fetcher })).toMatchObject({
      ok: true
    })
    expect(network).toHaveBeenCalledTimes(1)
  })
})
