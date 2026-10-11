import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { deflateSync } from 'node:zlib'
import { localD1 } from './admin-fixture'
import { featuredBadgeUrls, listingPath, site } from './site-fixture'

/**
 * Fixtures for the submit flow specs (#63): a local website the Worker can read and verify,
 * and direct writes to the local D1 that the UI cannot make yet (a prohibited-URL block is an
 * admin decision, #64).
 *
 * The website answers on `<label>.localtest.me:<port>`: `localtest.me` and its subdomains
 * resolve to 127.0.0.1, so the local Worker reaches this server while the address still passes
 * the submit flow's public-URL check (which refuses `localhost` and private IP literals).
 */

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/** A valid square RGBA PNG of one color. */
export function pngImage(size: number, rgb: [number, number, number] = [31, 111, 92]): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header.set([8, 6, 0, 0, 0], 8)
  const row = Buffer.alloc(1 + size * 4)
  for (let x = 0; x < size; x += 1) row.set([...rgb, 255], 1 + x * 4)
  const raw = Buffer.concat(Array.from({ length: size }, () => row))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

export interface FixtureProduct {
  /** `wrong`: the badge links to the site's home page instead of the listing. */
  badge: 'missing' | 'nofollow' | 'valid' | 'wrong'
  /** Delays the home page this long (a slow site; the Worker gives up after 8 seconds). */
  delayMs?: number
  description: string
  name: string
  /** Tells crawlers to skip the page's links: a robots meta tag or an X-Robots-Tag header. */
  robots?: 'header' | 'meta'
  /** The home page's HTTP status (default 200). */
  status?: number
}

export interface FixtureSite {
  close(): Promise<void>
  /** How many requests the label's home page has answered. */
  requests(label: string): number
  /** `http://<label>.localtest.me:<port>/` */
  website(label: string): string
  /** The submission slug (the host, without the port). */
  slug(label: string): string
  set(label: string, product: FixtureProduct): void
  update(label: string, change: Partial<FixtureProduct>): void
}

function page(product: FixtureProduct, slug: string): string {
  const listingUrl =
    product.badge === 'wrong' ? `${site.publicUrl}/` : `${site.publicUrl}${listingPath(slug)}`
  const badge =
    product.badge === 'missing'
      ? ''
      : `<a href="${listingUrl}" target="_blank" rel="${product.badge === 'nofollow' ? 'nofollow noopener' : 'noopener noreferrer'}" title="Featured on SERP Best"><img src="${featuredBadgeUrls.light}" alt="Featured on SERP Best" width="200" height="50" /></a>`
  return `<!doctype html><html><head>
<title>${product.name} — the fixture product</title>${product.robots === 'meta' ? '\n<meta name="robots" content="index, nofollow">' : ''}
<meta name="description" content="${product.description}">
<meta property="og:site_name" content="${product.name}">
<meta property="og:image" content="/og.png">
<link rel="icon" href="/favicon.ico" sizes="32x32">
<link rel="icon" type="image/png" href="/icon.png" sizes="180x180">
</head><body><h1>${product.name}</h1><footer>${badge}</footer></body></html>`
}

export async function startFixtureSite(): Promise<FixtureSite> {
  const products = new Map<string, FixtureProduct>()
  const homeRequests = new Map<string, number>()
  const icon = pngImage(180)
  const social = pngImage(256, [194, 85, 31])
  const server: Server = createServer((request, response) => {
    const host = (request.headers.host ?? '').split(':')[0] ?? ''
    const label = host.endsWith('.localtest.me') ? host.slice(0, -'.localtest.me'.length) : ''
    const product = products.get(label)
    if (!product) {
      response.writeHead(404, { 'content-type': 'text/plain' }).end('unknown fixture')
      return
    }
    const path = (request.url ?? '/').split('?')[0]
    if (path === '/') {
      homeRequests.set(label, (homeRequests.get(label) ?? 0) + 1)
      const respond = () =>
        response
          .writeHead(product.status ?? 200, {
            'content-type': 'text/html; charset=utf-8',
            ...(product.robots === 'header' ? { 'x-robots-tag': 'nofollow' } : {})
          })
          .end(page(product, host))
      if (product.delayMs) setTimeout(respond, product.delayMs)
      else respond()
    } else if (path === '/icon.png') {
      response.writeHead(200, { 'content-type': 'image/png' }).end(icon)
    } else if (path === '/og.png') {
      response.writeHead(200, { 'content-type': 'image/png' }).end(social)
    } else {
      response.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
    }
  })
  await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
  const { port } = server.address() as AddressInfo
  return {
    close: () => new Promise(resolveClose => server.close(() => resolveClose())),
    requests: label => homeRequests.get(label) ?? 0,
    set: (label, product) => products.set(label, product),
    slug: label => `${label}.localtest.me`,
    update: (label, change) => {
      const current = products.get(label)
      if (current) products.set(label, { ...current, ...change })
    },
    website: label => `http://${label}.localtest.me:${port}/`
  }
}

/**
 * Runs one SQL command on the local D1 of the preview Worker at `baseURL`, the one every spec
 * without a Worker of its own shares, through the Worker's own D1 (`localD1` in
 * `admin-fixture.ts`). Not `wrangler d1 execute --local`, which started a second Miniflare on the
 * same SQLite file: a Worker query that met its write failed (#200, #204, #389).
 */
export function executeLocalD1(baseURL: string | undefined, command: string): void {
  const { hostname, port } = new URL(baseURL ?? 'about:blank')
  if (hostname !== '127.0.0.1' || !port) {
    throw new Error(`Local D1 needs a local preview Worker on 127.0.0.1, not ${baseURL}.`)
  }
  localD1(command, { port: Number(port) })
}
