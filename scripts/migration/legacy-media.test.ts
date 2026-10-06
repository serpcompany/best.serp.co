import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { parseManifest } from '../d1-publisher.ts'
import { solidPng } from '../fixtures/solid-png'
import { mediaPlanSchema } from '../media-upload'
import {
  type CatalogListing,
  type CatalogMediaRow,
  type CatalogSnapshot,
  cachingFetch,
  classifySource,
  codePointCompare,
  currentSnapshot,
  DEFAULT_ASSETS,
  isAdultListing,
  isLikelyRebrand,
  migrateLegacyMedia,
  ownDomains,
  pageFlags,
  sourceFor,
  spamSignal
} from './legacy-media'

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

function listing(id: string, slug: string, website: string): CatalogListing {
  return { adult: false, id, slug, website }
}

/** A catalog whose every listing has a dead Cloudflare Images logo and featured image. */
function snapshot(listings: CatalogListing[]): CatalogSnapshot {
  const rows = (listingId: string): CatalogMediaRow[] =>
    (['image', 'logo'] as const).map(kind => ({
      bytes: null,
      content_type: null,
      height: null,
      kind,
      listing_id: listingId,
      media_key: null,
      sha256: null,
      sort_order: 0,
      url: `https://imagedelivery.net/x/${listingId}-${kind}/public`,
      width: null
    }))
  return { listings, rows }
}

const icon = solidPng(180, 180, [9, 9, 9])
const social = solidPng(1200, 630, [7, 7, 7])
const original = solidPng(256, 256, [5, 5, 5])
const html = (head: string) =>
  new Response(`<!doctype html><html><head>${head}</head><body></body></html>`, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  })
const image = (body: Uint8Array) =>
  new Response(new Uint8Array(body), { headers: { 'Content-Type': 'image/png' } })

/**
 * Every Cloudflare Images source is dead; a serp.ly short link refreshes to the product's own
 * domain (its path), whose page declares an SVG icon, an apple-touch-icon, and an og:image.
 */
const stubFetch: typeof fetch = async input => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  if (url.host === 'imagedelivery.net') return new Response('ERROR 9404', { status: 404 })
  if (url.host === 'serp.ly') {
    return html(`<meta http-equiv="refresh" content="0; url=https://${url.pathname.slice(1)}/">`)
  }
  if (url.pathname.endsWith('/touch.png')) return image(icon)
  if (url.pathname.endsWith('/card.png')) return image(social)
  if (url.pathname.endsWith('.png')) return image(original)
  return html(
    '<title>Product</title><link rel="icon" type="image/svg+xml" href="/logo.svg"><link rel="apple-touch-icon" href="/touch.png"><meta property="og:image" content="/card.png">'
  )
}

const cacheDirectory = mkdtempSync(join(tmpdir(), 'legacy-media-cache-'))
afterAll(() => rmSync(cacheDirectory, { force: true, recursive: true }))

describe('legacy media migration (#95)', () => {
  it('sends each imported reference to the right source', () => {
    expect(classifySource('/media/products/coomer-downloader/featured.webp')).toBe('media-products')
    expect(sourceFor('/media/products/coomer-downloader/featured.webp')).toBe(
      'https://apps.serp.co/media/products/coomer-downloader/featured.webp'
    )
    expect(sourceFor('/listing-logos/serpdownloaders.com/beeg-downloader.png')).toBe(
      'repo:apps/web/public/listing-logos/serpdownloaders.com/beeg-downloader.png'
    )
    expect(sourceFor('/media/products/launchbuzz.io/og.png')).toBe(
      'repo:apps/web/public/media/products/launchbuzz.io/og.png'
    )
    expect(classifySource('https://imagedelivery.net/a/b/public')).toBe('imagedelivery.net')
  })

  it('hosts live sources, replaces dead ones from the product site, and writes row-level manifests', async () => {
    const result = await migrateLegacyMedia({
      fetcher: stubFetch,
      limit: 6,
      listingsPerManifest: 4,
      snapshot: snapshot([
        listing('lst_test_a_0000', 'alpha.test', 'https://serp.ly/alpha.test'),
        listing('lst_test_b_0000', 'beta.test', 'https://beta.test/'),
        listing('lst_test_c_0000', 'gamma.test', 'https://serp.ly/gamma.test')
      ])
    })
    const plan = mediaPlanSchema.parse(result.plan)
    expect(result.manifests.map(manifest => manifest.file)).toEqual([
      'd1/publications/2026-10-06-legacy-media-01.yaml'
    ])
    const [manifest] = result.manifests.map(entry => parseManifest(entry.text))
    expect(manifest?.concurrency).toBe('rows')
    expect(manifest?.basePublicationVersion).toBeUndefined()
    expect(manifest?.operations).toHaveLength(3)
    // Every dead Cloudflare Images logo was replaced by the product's own icon, never kept.
    for (const outcome of result.outcomes) expect(outcome.logo.kind).toBe('replaced')
    const keys = new Set(plan.objects.map(object => object.key))
    for (const op of manifest?.operations ?? []) {
      if (op.action !== 'listing-media-update') throw new Error('Unexpected operation.')
      for (const hosted of [op.media.logo, ...(op.media.images ?? [])]) {
        if (hosted) expect(keys.has(hosted.key), hosted.key).toBe(true)
      }
      expect(op.expected.map(row => row.key)).toEqual(op.expected.map(() => null))
    }
    expect(plan.objects.every(object => !object.source.includes('imagedelivery.net'))).toBe(true)
    expect(result.report).toContain('replaced from the site icon')
  }, 120_000)

  it('refuses replacements from pages the listing does not own, or that are parked or gambling (#98 B1)', async () => {
    const pages: Record<string, string> = {
      // A short link that now lands on another domain.
      'hijacked.test':
        '<meta http-equiv="refresh" content="0; url=https://casino-elsewhere.test/">',
      // The listing's own domain, now a gambling page.
      'togel.test': '<title>SITUS TOGEL 4D Resmi</title>',
      // The listing's own domain, parked for sale.
      'parked.test':
        '<title>parked.test</title><body>This domain is for sale. Make an offer.</body>',
      // SERP's own app page (allowed for every listing).
      'serpapp.test': '<meta http-equiv="refresh" content="0; url=https://apps.serp.co/serpapp">'
    }
    const fetcher: typeof fetch = async input => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.host === 'imagedelivery.net') return new Response('ERROR 9404', { status: 404 })
      const own = pages[url.host]
      if (own) return html(own)
      if (url.host === 'serp.ly') return html(pages[url.pathname.slice(1)] ?? '')
      if (url.pathname.endsWith('.png')) return image(icon)
      return html(
        '<title>Elsewhere</title><link rel="apple-touch-icon" href="/touch.png"><meta property="og:image" content="/card.png">'
      )
    }
    const result = await migrateLegacyMedia({
      fetcher,
      snapshot: snapshot([
        listing('lst_test_h_0000', 'hijacked.test', 'https://serp.ly/hijacked.test'),
        listing('lst_test_t_0000', 'togel.test', 'https://togel.test/'),
        listing('lst_test_p_0000', 'parked.test', 'https://parked.test/'),
        // A SERP app, adult: its curated apps.serp.co screenshot is used, never SERP Apps' icon.
        {
          ...listing('lst_test_s_0000', 'serpapp-downloader', 'https://serp.ly/serpapp.test'),
          adult: true
        }
      ])
    })
    const reasons = Object.fromEntries(
      result.outcomes.map(outcome => [outcome.slug, outcome.refused?.reasons.join('; ')])
    )
    expect(reasons['hijacked.test']).toMatch(/^off-domain page casino-elsewhere\.test/u)
    expect(reasons['togel.test']).toMatch(/gambling or spam \("togel"\)/u)
    expect(reasons['parked.test']).toMatch(/for sale or parked/u)
    for (const outcome of result.outcomes) expect(outcome.logo.kind).toBe('tile')
    const serpApp = result.outcomes.find(outcome => outcome.slug === 'serpapp-downloader')
    expect(serpApp?.logo).toEqual({
      kind: 'tile',
      reason: 'http_404; SERP app page: its icon is SERP Apps’, not the app’s'
    })
    expect(serpApp?.images).toEqual({ from: 'serp-app', kind: 'replaced', source: 'apps.serp.co' })
    expect(result.plan.objects.map(object => object.source)).toEqual([
      'https://apps.serp.co/card.png'
    ])
    expect(result.report).toContain('### Replacements refused')
    expect(result.report).toContain('`hijacked.test` | https://casino-elsewhere.test/')
  }, 120_000)

  it('follows a dead short link to the slug’s domain, hints rebrands, and takes approved ones (#98 r2)', async () => {
    const pages: Record<string, string> = {
      // A dead short link ends on serp.co's catch-all: the product is still at its slug's domain.
      'brightlocal.test': '<meta http-equiv="refresh" content="0; url=https://serp.co/?catchall">',
      // The same brand on a new domain.
      'notion.test': '<meta http-equiv="refresh" content="0; url=https://notion.example/">',
      'lambdalabs.test': '<meta http-equiv="refresh" content="0; url=https://lambda.example/">'
    }
    const fetcher: typeof fetch = async input => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.host === 'imagedelivery.net') return new Response('gone', { status: 404 })
      if (url.host === 'serp.ly') return html(pages[url.pathname.slice(1)] ?? '')
      if (url.pathname.endsWith('.png')) return image(icon)
      return html('<title>Product</title><link rel="apple-touch-icon" href="/touch.png">')
    }
    const listings = [
      listing('lst_test_b_0000', 'brightlocal.test', 'https://serp.ly/brightlocal.test'),
      listing('lst_test_n_0000', 'notion.test', 'https://serp.ly/notion.test'),
      listing('lst_test_l_0000', 'lambdalabs.test', 'https://serp.ly/lambdalabs.test')
    ]
    const first = await migrateLegacyMedia({ fetcher, snapshot: snapshot(listings) })
    const bySlug = (result: typeof first, slug: string) =>
      result.outcomes.find(outcome => outcome.slug === slug)
    expect(bySlug(first, 'brightlocal.test')?.logo).toMatchObject({
      kind: 'replaced',
      source: 'brightlocal.test'
    })
    expect(bySlug(first, 'notion.test')?.refused?.reasons).toEqual([
      'likely rebrand to notion.example'
    ])
    expect(bySlug(first, 'lambdalabs.test')?.refused?.reasons).toEqual([
      'likely rebrand to lambda.example'
    ])
    expect(first.report).toContain('### Likely rebrands')
    // The owner approves one: the next regeneration takes its replacement.
    const approved = await migrateLegacyMedia({
      allowedDomains: { 'notion.test': 'notion.example' },
      fetcher,
      listingsPerManifest: 1,
      migrationId: 'legacy-media-regenerated',
      snapshot: snapshot(listings)
    })
    expect(bySlug(approved, 'notion.test')?.logo).toMatchObject({ kind: 'replaced' })
    expect(bySlug(approved, 'lambdalabs.test')?.logo.kind).toBe('tile')
    // `--part-size` and `--manifest-id`: one listing per part, under the new id.
    expect(approved.manifests.map(manifest => manifest.file)).toEqual([
      'd1/publications/legacy-media-regenerated-01.yaml',
      'd1/publications/legacy-media-regenerated-02.yaml',
      'd1/publications/legacy-media-regenerated-03.yaml'
    ])
    expect(approved.plan.id).toBe('legacy-media-regenerated')
    expect(isLikelyRebrand(new Set(['hijacked.test']), 'casino.example')).toBe(false)
  }, 120_000)

  it('treats adult platforms as adult by name, whatever their category (#98 r2 S2)', async () => {
    const adultByName = listing(
      'lst_test_x_0000',
      'xhamster-downloader',
      'https://xhamster.example/'
    )
    expect(isAdultListing(adultByName)).toBe(true)
    expect(isAdultListing(listing('lst_test_y_0000', 'notion.ai', 'https://notion.ai/'))).toBe(
      false
    )
    // A short brand never matches inside a word: "jerome" is not "erome".
    expect(
      isAdultListing(
        listing('lst_test_z_0000', 'institutional.test', 'https://serp.ly/jerome-powell-bot')
      )
    ).toBe(false)
    expect(
      isAdultListing(listing('lst_test_w_0000', 'beeg-downloader', 'https://serp.ly/beeg'))
    ).toBe(true)
    const result = await migrateLegacyMedia({
      fetcher: async input => {
        const url = new URL(input instanceof Request ? input.url : String(input))
        if (url.host === 'imagedelivery.net') return new Response('gone', { status: 404 })
        if (url.pathname === '/touch.png') return image(icon)
        if (url.pathname === '/card.png') return image(social)
        return html(
          '<link rel="apple-touch-icon" href="/touch.png"><meta property="og:image" content="/card.png">'
        )
      },
      snapshot: snapshot([
        { ...adultByName, categories: ['video-downloaders'], slug: 'xhamster.example' }
      ])
    })
    // A separate row-level manifest adds the Adult category (owner decision on #98).
    const category = parseManifest(result.categoryManifest?.text ?? '')
    expect(result.categoryManifest?.file).toBe(
      'd1/publications/2026-10-06-legacy-media-adult-category.yaml'
    )
    expect(category.concurrency).toBe('rows')
    expect(category.operations).toEqual([
      {
        action: 'listing-categories-add',
        add: ['adult'],
        expected: ['video-downloaders'],
        id: 'lst_test_x_0000',
        slug: 'xhamster.example'
      }
    ])
    const [outcome] = result.outcomes
    expect(outcome?.adult).toBe(true)
    expect(outcome?.images).toEqual({
      kind: 'dropped',
      reason: 'adult listing: only a SERP-curated screenshot is used'
    })
    expect(result.report).toContain('`xhamster.example`')
    // The create-react-app and current create-next-app defaults are blocked (#98 r2 S1).
    for (const prefix of ['3d10f7da', 'c386396e', '9ea4f4da', 'c28fdd2a']) {
      expect(
        Object.keys(DEFAULT_ASSETS).some(digest => digest.startsWith(prefix)),
        prefix
      ).toBe(true)
    }
  }, 120_000)

  it('keeps adult listings off other sites’ Open Graph images, and drops default assets (#98)', async () => {
    const chevron = solidPng(32, 32, [1, 2, 3])
    const result = await migrateLegacyMedia({
      fetcher: async input => {
        const url = new URL(input instanceof Request ? input.url : String(input))
        if (url.host === 'imagedelivery.net') return new Response('gone', { status: 404 })
        if (url.pathname === '/touch.png') return image(icon)
        if (url.pathname === '/card.png') return image(social)
        return html(
          '<link rel="apple-touch-icon" href="/touch.png"><meta property="og:image" content="/card.png">'
        )
      },
      snapshot: snapshot([
        { ...listing('lst_test_x_0000', 'adult.test', 'https://adult.test/'), adult: true }
      ])
    })
    const [outcome] = result.outcomes
    expect(outcome?.logo.kind).toBe('replaced')
    expect(outcome?.images).toEqual({
      kind: 'dropped',
      reason: 'adult listing: only a SERP-curated screenshot is used'
    })
    expect(DEFAULT_ASSETS[sha(chevron)]).toBeUndefined()
    expect(Object.keys(DEFAULT_ASSETS).every(digest => /^[0-9a-f]{64}$/u.test(digest))).toBe(true)
  }, 120_000)

  it('judges pages by their own wording, not by a pricing page’s "bonus"', () => {
    expect(
      spamSignal(
        'Pricing · Get a bonus month',
        'bonus bonus bonus bonus bonus bonus bonus bonus bonus bonus'
      )
    ).toBeNull()
    expect(spamSignal('Calendar slots for teams', 'slot slot slot slots slots')).toBeNull()
    expect(spamSignal('Best Online Casinos in Canada', '')).toBe('casinos')
    expect(spamSignal('Vegas123 | Promo Member Baru & Bonus Harian', 'bonus daftar bonus')).toBe(
      'bonus'
    )
    expect(spamSignal('An AI motion capture tool', 'casino online casino non aams')).toBe('casino')
    expect(spamSignal('UY88 Link Nhà Cái Chính Thức', '')).toBe('nhà cái')
    expect(
      pageFlags({ html: '<title>Hello</title>', url: 'https://www.snagged.com/domains/x' })
    ).toEqual(['parking host www.snagged.com'])
  })

  it('owns its website’s and slug’s registrable domains, never a shortener’s or serp.co', () => {
    expect(
      [...ownDomains({ slug: 'app.example.co.uk', website: 'https://serp.ly/x' })].sort()
    ).toEqual(['example.co.uk'])
    expect(
      [...ownDomains({ slug: 'cam4-downloader', website: 'https://www.cam4.example/' })].sort()
    ).toEqual(['cam4.example'])
    expect(['b', 'a', 'B', 'é'].sort(codePointCompare)).toEqual(['B', 'a', 'b', 'é'])
  })

  it('regenerates from an environment’s current rows, keeping hosted rows as they are (#98 S4)', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'legacy-media-current-'))
    try {
      const wrangler = (results: unknown[]) => JSON.stringify([{ results, success: true }])
      const hostedKey = `best.serp.co/listings/beta.test/logo/${'a'.repeat(16)}.png`
      writeFileSync(
        join(directory, 'listings.json'),
        wrangler([
          { adult: 0, id: 'lst_test_a_0000', slug: 'alpha.test', website: 'https://alpha.test/' },
          { adult: 0, id: 'lst_test_b_0000', slug: 'beta.test', website: 'https://beta.test/' }
        ])
      )
      const row = (listingId: string, kind: string, url: string, hosted?: string) => ({
        bytes: hosted ? 10 : null,
        content_type: hosted ? 'image/png' : null,
        height: hosted ? 64 : null,
        kind,
        listing_id: listingId,
        media_key: hosted ?? null,
        sha256: hosted ? 'a'.repeat(64) : null,
        sort_order: 0,
        url,
        width: hosted ? 64 : null
      })
      writeFileSync(
        join(directory, 'media.json'),
        wrangler([
          row('lst_test_a_0000', 'logo', 'https://imagedelivery.net/x/a/public'),
          // An admin already hosted beta's logo: kept, not fetched, not uploaded again.
          row('lst_test_b_0000', 'logo', 'https://beta.test/logo.png', hostedKey)
        ])
      )
      const result = await migrateLegacyMedia({
        fetcher: stubFetch,
        snapshot: currentSnapshot(directory)
      })
      const [manifest] = result.manifests.map(entry => parseManifest(entry.text))
      expect(manifest?.operations.map(op => ('slug' in op ? op.slug : ''))).toEqual(['alpha.test'])
      expect(result.plan.objects.map(object => object.key)).not.toContain(hostedKey)
      expect(result.outcomes.find(outcome => outcome.slug === 'beta.test')?.logo).toEqual({
        kind: 'hosted',
        source: 'already hosted'
      })
    } finally {
      rmSync(directory, { force: true, recursive: true })
    }
  }, 120_000)

  it('replays cached answers, redirects included, without fetching again', async () => {
    let calls = 0
    const counted: typeof fetch = async (input, init) => {
      calls += 1
      return stubFetch(input, init)
    }
    const cached = cachingFetch(cacheDirectory, false, new Set(), counted)
    const first = await cached('https://serp.ly/x')
    const again = await cached('https://serp.ly/x')
    expect(await first.text()).toBe(await again.text())
    expect(calls).toBe(1)
    // A refused private address is cached as such and replays as the same refusal.
    const restricted = cachingFetch(cacheDirectory, false, new Set(), async () => {
      throw Object.assign(new Error('private'), { name: 'RestrictedAddressError' })
    })
    await expect(restricted('https://internal.example/')).rejects.toMatchObject({
      name: 'RestrictedAddressError'
    })
    await expect(
      cachingFetch(cacheDirectory, false, new Set(), counted)('https://internal.example/')
    ).rejects.toMatchObject({ name: 'RestrictedAddressError' })
  })
})
