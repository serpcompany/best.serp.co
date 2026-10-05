import { describe, expect, it } from 'vitest'
import {
  checkLogoUrl,
  decodeEntities,
  fitShortDescription,
  iconCandidates,
  inspectImage,
  parseSiteMetadata,
  proposeName,
  readSitePrefill
} from './prefill'

/** The first bytes of a PNG with the given size (enough for the IHDR reader). */
function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13], 0)
  bytes.set(
    [...'IHDR'].map(char => char.charCodeAt(0)),
    12
  )
  new DataView(bytes.buffer).setUint32(16, width)
  new DataView(bytes.buffer).setUint32(20, height)
  return bytes
}

function jpeg(width: number, height: number): Uint8Array {
  // SOI, an APP0 segment of length 4, then SOF0 with height and width.
  return new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xe0,
    0x00,
    0x04,
    0x00,
    0x00,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    height >> 8,
    height & 255,
    width >> 8,
    width & 255,
    0x03
  ])
}

function webpVp8x(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30)
  bytes.set(
    [...'RIFF'].map(char => char.charCodeAt(0)),
    0
  )
  bytes.set(
    [...'WEBPVP8X'].map(char => char.charCodeAt(0)),
    8
  )
  const w = width - 1
  const h = height - 1
  bytes.set(
    [w & 255, (w >> 8) & 255, (w >> 16) & 255, h & 255, (h >> 8) & 255, (h >> 16) & 255],
    24
  )
  return bytes
}

const PAGE = `<!doctype html><html><head>
  <title>Quillmate &mdash; AI copywriting for busy founders</title>
  <meta name="description" content="Turns rough product notes into on-brand landing pages, emails, and ads.">
  <meta property="og:site_name" content="Quillmate">
  <meta property="og:image" content="/og.png">
  <link rel="icon" href="/favicon.ico" sizes="32x32">
  <link rel="icon" type="image/png" href="/icon-192.png" sizes="192x192">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
</head><body><meta name="description" content="Ignored: body"></body></html>`

function site(routes: Record<string, { body: BodyInit; status?: number; type: string }>) {
  const calls: string[] = []
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    calls.push(url.pathname)
    const route = routes[url.pathname]
    if (!route) return new Response('missing', { status: 404 })
    return new Response(route.body, {
      headers: { 'content-type': route.type },
      status: route.status ?? 200
    })
  }) as typeof fetch
  return { calls, fetcher }
}

describe('page metadata', () => {
  it('reads the head only, decodes entities, and ranks icons largest first', () => {
    const metadata = parseSiteMetadata(PAGE, 'https://quillmate.app/')
    expect(metadata).toMatchObject({
      description: {
        source: 'meta description',
        value: 'Turns rough product notes into on-brand landing pages, emails, and ads.'
      },
      ogSiteName: 'Quillmate',
      socialImage: 'https://quillmate.app/og.png',
      title: 'Quillmate — AI copywriting for busy founders'
    })
    expect(iconCandidates(metadata, 'https://quillmate.app/')).toEqual([
      'https://quillmate.app/icon-192.png',
      'https://quillmate.app/apple-touch-icon.png'
    ])
  })

  it('proposes a name from og:site_name, application-name, or the title’s first part', () => {
    const base = parseSiteMetadata('<title>Brieflow | Meeting notes</title>', 'https://b.ai/')
    expect(proposeName(base)).toEqual({ source: 'page title', value: 'Brieflow' })
    expect(
      proposeName(
        parseSiteMetadata('<meta name="application-name" content="Brief">', 'https://b.ai/')
      )
    ).toEqual({ source: 'application-name', value: 'Brief' })
    expect(proposeName(parseSiteMetadata('<p>nothing</p>', 'https://b.ai/'))).toBeNull()
  })

  it('falls back to og:description and ignores unsafe or data URLs', () => {
    const metadata = parseSiteMetadata(
      `<meta property="og:description" content="  Spaced
        out  "><meta property="og:image" content="http://127.0.0.1/x.png">
        <link rel="icon" href="data:image/png;base64,AAAA">`,
      'https://example.com/'
    )
    expect(metadata.description).toEqual({ source: 'og:description', value: 'Spaced out' })
    expect(metadata.socialImage).toBeNull()
    expect(metadata.icons).toEqual([])
  })

  it('shortens long descriptions to 160 characters at a word boundary', () => {
    const long = `${'word '.repeat(40)}end`
    const fitted = fitShortDescription(long)
    expect(fitted.length).toBeLessThanOrEqual(160)
    expect(fitted.endsWith('word…')).toBe(true)
    expect(fitShortDescription('Short.')).toBe('Short.')
    expect(decodeEntities('A &amp; B &#8217; &#x2014; &bogus;')).toBe('A & B ’ — &bogus;')
  })
})

describe('logo images', () => {
  it('identifies images by their bytes and reads their size', () => {
    expect(inspectImage(png(180, 180))).toEqual({ format: 'png', height: 180, width: 180 })
    expect(inspectImage(jpeg(640, 480))).toEqual({ format: 'jpeg', height: 480, width: 640 })
    expect(inspectImage(webpVp8x(256, 128))).toEqual({ format: 'webp', height: 128, width: 256 })
    expect(
      inspectImage(new TextEncoder().encode('<?xml version="1.0"?>\n<svg viewBox="0 0 1 1"/>'))
    ).toEqual({ format: 'svg', height: null, width: null })
    expect(inspectImage(new TextEncoder().encode('<html>not an image</html>'))).toBeNull()
  })

  it('accepts a public image of at least 128 px and at most 1 MB', async () => {
    const { fetcher } = site({
      '/big.png': { body: png(512, 512), type: 'image/png' },
      '/huge.png': { body: new Uint8Array(1_000_001), type: 'image/png' },
      '/page.html': { body: '<html></html>', type: 'text/html' },
      '/small.png': { body: png(64, 64), type: 'image/png' },
      '/octet.png': { body: png(200, 200), type: 'application/octet-stream' }
    })
    await expect(checkLogoUrl('https://example.com/big.png', fetcher)).resolves.toMatchObject({
      ok: true
    })
    await expect(checkLogoUrl('https://example.com/octet.png', fetcher)).resolves.toMatchObject({
      ok: true
    })
    for (const [path, code] of [
      ['/small.png', 'logo_too_small'],
      ['/huge.png', 'logo_too_large'],
      ['/page.html', 'logo_not_image'],
      ['/missing.png', 'logo_unreachable']
    ] as const) {
      await expect(checkLogoUrl(`https://example.com${path}`, fetcher), path).resolves.toEqual({
        code,
        ok: false
      })
    }
    await expect(checkLogoUrl('http://10.0.0.1/logo.png', fetcher)).resolves.toEqual({
      code: 'logo_unreachable',
      ok: false
    })
  })
})

describe('site prefill', () => {
  it('proposes the name, description, a checked site icon, and the social image', async () => {
    const { calls, fetcher } = site({
      '/': { body: PAGE, type: 'text/html; charset=utf-8' },
      '/icon-192.png': { body: png(192, 192), type: 'image/png' },
      '/og.png': { body: png(1200, 630), type: 'image/png' }
    })
    await expect(readSitePrefill('https://www.quillmate.app/', fetcher)).resolves.toEqual({
      description: {
        source: 'meta description',
        value: 'Turns rough product notes into on-brand landing pages, emails, and ads.'
      },
      host: 'quillmate.app',
      name: { source: 'og:site_name', value: 'Quillmate' },
      ok: true,
      siteIcon: 'https://www.quillmate.app/icon-192.png',
      socialImage: 'https://www.quillmate.app/og.png'
    })
    // The 32 px favicon is never fetched.
    expect(calls).not.toContain('/favicon.ico')
  })

  it('reports a page it could not read, so the form can say so', async () => {
    const { fetcher } = site({ '/': { body: 'nope', status: 503, type: 'text/html' } })
    await expect(readSitePrefill('https://down.example/', fetcher)).resolves.toEqual({
      code: 'http_503',
      host: 'down.example',
      ok: false
    })
    const timeout = (async () => {
      throw new DOMException('timed out', 'TimeoutError')
    }) as typeof fetch
    await expect(readSitePrefill('https://slow.example/', timeout)).resolves.toMatchObject({
      code: 'fetch_timeout',
      ok: false
    })
  })
})
