import { lookup as dnsLookup, type LookupAddress } from 'node:dns'
import { isIP } from 'node:net'
import { Agent, fetch as undiciFetch } from 'undici'
import { validatePublicHttpUrl } from './public-url'

/**
 * The `fetch` for `safeFetch` outside the Worker (the legacy media migration, the media upload;
 * serpcompany/best.serp.co#95). `validatePublicHttpUrl` reads only the URL's text, and the Worker
 * relies on Cloudflare's egress for a public name that resolves to a private address. A Node
 * process has no such egress: it may run on a self-hosted runner (#55) or a laptop, next to
 * private services. So every connection (`safeFetch` makes one per redirect hop) resolves its
 * host once, refuses it unless every address is public by the same policy (private, loopback,
 * link-local, and unique-local ranges, and the IPv4-mapped, compatible, NAT64, 6to4, and Teredo
 * IPv6 forms), and connects to exactly the address it checked: the undici dispatcher's
 * `connect.lookup` is the check, so a rebinding resolver cannot answer public for the check and
 * private for the connection (#96 review round 2, S3). The URL is unchanged, so the `Host`
 * header and TLS SNI stay the host's. Only ports 80 and 443 are allowed.
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

const resolveAll: Resolver = hostname =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error) reject(error)
      else resolve((addresses as LookupAddress[]).map(entry => entry.address))
    })
  })

type LookupCallback = (
  error: Error | null,
  address: string | LookupAddress[],
  family?: number
) => void

/**
 * `net.connect`'s `lookup` for the dispatcher: resolves once, refuses unless every address is
 * public (`allow`), and hands the connection only the addresses it checked.
 */
export function pinnedLookup(
  resolve: Resolver = resolveAll,
  allow: (address: string) => boolean = isPublicAddress
) {
  return (hostname: string, options: { all?: boolean }, callback: LookupCallback): void => {
    resolve(hostname).then(
      addresses => {
        if (addresses.length === 0 || addresses.some(address => !allow(address))) {
          callback(new RestrictedAddressError(`${hostname} resolves to a restricted address.`), [])
          return
        }
        const checked = addresses.map(address => ({ address, family: isIP(address) }))
        const [first] = checked
        if (options.all) callback(null, checked)
        else callback(null, first?.address ?? '', first?.family)
      },
      error => callback(error instanceof Error ? error : new Error(String(error)), [])
    )
  }
}

/** The `RestrictedAddressError` an undici failure wraps (`TypeError: fetch failed`), if any. */
function restrictedCause(error: unknown): RestrictedAddressError | null {
  let current: unknown = error
  for (let depth = 0; current && depth < 5; depth += 1) {
    if (current instanceof Error && current.name === 'RestrictedAddressError') {
      return current as RestrictedAddressError
    }
    current = current instanceof Error ? (current as Error & { cause?: unknown }).cause : null
  }
  return null
}

export function createNodeFetch(
  options: {
    /** Test hook: which resolved addresses may be connected to (default: public ones). */
    allowAddress?: (address: string) => boolean
    /** Test hook: which URLs' ports may be fetched (default: 80 and 443). */
    allowPort?: (url: URL) => boolean
    resolve?: Resolver
  } = {}
): typeof fetch {
  const allowAddress = options.allowAddress ?? isPublicAddress
  const dispatcher = new Agent({
    connect: { lookup: pinnedLookup(options.resolve, allowAddress) as never }
  })
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (!(options.allowPort ?? isAllowedPort)(url)) {
      throw new RestrictedAddressError(`Port ${url.port} is not allowed.`)
    }
    // An IP literal is never looked up, so it is checked here.
    const host = url.hostname.replace(/^\[|\]$/gu, '')
    if (isIP(host) && !allowAddress(host)) {
      throw new RestrictedAddressError(`${host} is a restricted address.`)
    }
    try {
      const response = await undiciFetch(url, {
        ...(init as Record<string, unknown>),
        dispatcher
      } as Parameters<typeof undiciFetch>[1])
      return response as unknown as Response
    } catch (error) {
      throw restrictedCause(error) ?? error
    }
  }
}

/** `fetch` for Node scripts: every hop's connection pinned to an address checked as public. */
export const nodeFetch: typeof fetch = createNodeFetch()
