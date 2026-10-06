import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { validatePublicHttpUrl } from './public-url'

/**
 * The `fetch` for `safeFetch` outside the Worker (the legacy media migration, the media upload;
 * serpcompany/best.serp.co#95). `validatePublicHttpUrl` reads only the URL's text, and the Worker
 * relies on Cloudflare's egress for a public name that resolves to a private address. A Node
 * process has no such egress, so every request (`safeFetch` calls this once per redirect hop)
 * resolves its host first and refuses it unless every address is public by the same policy:
 * private, loopback, link-local, and unique-local ranges, and the IPv4-mapped, compatible,
 * NAT64, 6to4, and Teredo IPv6 forms. Only ports 80 and 443 are allowed.
 *
 * A host that resolves differently between this lookup and the connection (DNS rebinding) is
 * not covered; the scripts that use it run once, on ephemeral GitHub runners.
 */

export class RestrictedAddressError extends Error {
  override name = 'RestrictedAddressError'
}

/** True when an IP address literal is public by the URL policy. */
export function isPublicAddress(address: string): boolean {
  const literal = address.includes(':') ? `[${address}]` : address
  return validatePublicHttpUrl(`http://${literal}/`).ok
}

export function isAllowedPort(url: URL): boolean {
  return url.port === '' || url.port === '80' || url.port === '443'
}

type Resolver = (hostname: string) => Promise<readonly string[]>

const resolveAll: Resolver = async hostname =>
  (await lookup(hostname, { all: true, verbatim: true })).map(entry => entry.address)

export function createNodeFetch(
  options: { fetch?: typeof fetch; resolve?: Resolver } = {}
): typeof fetch {
  const resolve = options.resolve ?? resolveAll
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (!isAllowedPort(url)) throw new RestrictedAddressError(`Port ${url.port} is not allowed.`)
    const host = url.hostname.replace(/^\[|\]$/gu, '')
    const addresses = isIP(host) ? [host] : await resolve(host)
    if (addresses.length === 0 || addresses.some(address => !isPublicAddress(address))) {
      throw new RestrictedAddressError(`${host} resolves to a restricted address.`)
    }
    return (options.fetch ?? fetch)(input, init)
  }
}

/** `fetch` for Node scripts: DNS-checked on every hop. */
export const nodeFetch: typeof fetch = createNodeFetch()
