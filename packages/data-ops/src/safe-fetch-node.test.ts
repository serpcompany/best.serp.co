import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { safeFetch } from './safe-fetch'
import { createNodeFetch, isPublicAddress, pinnedLookup } from './safe-fetch-node'

const options = {
  accept: () => true,
  acceptHeader: '*/*',
  maxBytes: 64
}

/** A local server standing in for a public site: every hop connects here, by address. */
let server: Server
let port = 0
const requests: Array<{ host: string | undefined; path: string | undefined }> = []
beforeAll(async () => {
  server = createServer((request: IncomingMessage, response) => {
    requests.push({ host: request.headers.host, path: request.url })
    if (request.url === '/redirect') {
      response.writeHead(302, { Location: `http://rebound.test:${port}/` })
      response.end()
      return
    }
    response.writeHead(200, { 'Content-Type': 'text/plain' })
    response.end('ok')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})
afterAll(() => new Promise<void>(resolve => server.close(() => resolve())))

/** Names resolve as the test says; only the local server's loopback address stands in as public. */
const addresses: Record<string, string[]> = {
  'mixed.test': ['93.184.216.34', '10.0.0.1'],
  'public.test': ['127.0.0.1'],
  'rebound.test': ['10.1.2.3']
}
function testFetch(resolve = async (host: string) => addresses[host] ?? []) {
  return createNodeFetch({
    allowAddress: address => address === '127.0.0.1' || isPublicAddress(address),
    allowPort: url => url.port === String(port) || url.port === '',
    resolve
  })
}

describe('safeFetch in Node (DNS-checked, connection pinned)', () => {
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

  it('connects to the address it checked, keeping the host name for Host', async () => {
    requests.length = 0
    let lookups = 0
    const fetcher = testFetch(async host => {
      lookups += 1
      return addresses[host] ?? []
    })
    const result = await safeFetch(`http://public.test:${port}/page`, { ...options, fetcher })
    expect(result).toMatchObject({ ok: true })
    expect(requests).toEqual([{ host: `public.test:${port}`, path: '/page' }])
    // One resolution per connection: the check and the connection use the same answer.
    expect(lookups).toBe(1)
  })

  it('checks every hop: a name resolving privately, or a redirect to one, is refused', async () => {
    requests.length = 0
    const fetcher = testFetch()
    expect(await safeFetch(`http://public.test:${port}/redirect`, { ...options, fetcher })).toEqual(
      { code: 'invalid_target', ok: false }
    )
    expect(requests.map(request => request.path)).toEqual(['/redirect'])
    for (const host of ['rebound.test', 'mixed.test', 'unknown.test']) {
      expect(await safeFetch(`http://${host}:${port}/`, { ...options, fetcher }), host).toEqual({
        code: 'invalid_target',
        ok: false
      })
    }
    expect(requests.map(request => request.path)).toEqual(['/redirect'])
  })

  it('cannot be rebound: a resolver that answers public, then private, connects nowhere private', async () => {
    const answers = [['93.184.216.34'], ['10.0.0.1']]
    const lookup = pinnedLookup(async () => answers.shift() ?? [])
    const first = await new Promise(resolve =>
      lookup('rebind.test', { all: true }, (error, address) => resolve({ address, error }))
    )
    expect(first).toEqual({ address: [{ address: '93.184.216.34', family: 4 }], error: null })
    const second = await new Promise<{ error: Error | null }>(resolve =>
      lookup('rebind.test', {}, error => resolve({ error }))
    )
    expect(second.error?.name).toBe('RestrictedAddressError')
  })

  it('refuses IP literals and ports other than 80 and 443 before connecting', async () => {
    const fetcher = createNodeFetch({ resolve: async () => ['93.184.216.34'] })
    for (const url of ['http://127.0.0.1/', 'http://[::1]/', 'https://example.com:6379/']) {
      expect(await safeFetch(url, { ...options, fetcher }), url).toEqual({
        code: 'invalid_target',
        ok: false
      })
    }
  })
})

/**
 * Opt-in network smoke test (`NETWORK_SMOKE=1`): a real public HTTPS fetch through the pinned
 * dispatcher, its DNS lookup, and TLS, on whatever Node runs it (`.nvmrc` in the workflows). Off
 * by default, so CI never depends on the network.
 */
describe.runIf(process.env.NETWORK_SMOKE === '1')('pinned Node fetch on the network', () => {
  it('fetches a real public HTTPS page through the pinned dispatcher and safeFetch', async () => {
    const response = await createNodeFetch()('https://www.example.com/')
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('Example Domain')
    const result = await safeFetch('https://example.com/', {
      accept: type => type === 'text/html',
      acceptHeader: 'text/html',
      fetcher: createNodeFetch(),
      maxBytes: 1_000_000,
      webPortsOnly: true
    })
    expect(result.ok).toBe(true)
  })
})
