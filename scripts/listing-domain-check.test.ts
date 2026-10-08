import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { assertD1StatementLimits } from '../apps/web/src/db/sql-limits'
import { describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import { freshMigrationNames, freshMigrationsDirectory } from './d1-drizzle-local'
import { readParityReport, readReviewedImportSql } from './d1-import-artifact'
import { buildPublicationPlan, parseManifest } from './d1-publisher'
import {
  buildDeadDomainManifest,
  buildDecisionsManifest,
  buildReport,
  buildUnpublishManifest,
  type CatalogListing,
  type DomainReport,
  deadDomainEntries,
  decisionsPathFor,
  type OwnerListDecisions,
  parseArguments,
  recheckPathFor,
  reviewedImportListings
} from './listing-domain-check'
import {
  type CheckedListing,
  classifyListing,
  expectedDomain,
  ownDomainUrl,
  registrableDomain
} from './listing-domain-classifier'
import {
  clientRedirect,
  DOMAIN_CHECK_USER_AGENT,
  guardedFetch,
  type Hop,
  isPublicAddress,
  pageSignals,
  type SiteObservation,
  traceWebsite,
  vettedLookup
} from './listing-domain-fetch'

const listing = (overrides: Partial<CheckedListing> = {}): CheckedListing => ({
  description: 'Writes marketing copy with AI.',
  id: 'lst_fixture00001',
  name: 'Acme',
  slug: 'acme.ai',
  website: 'https://serp.ly/acme',
  ...overrides
})

const html = (title: string, body: string, head = '') =>
  `<!doctype html><html><head><title>${title}</title>${head}</head><body>${body}</body></html>`

/** An observation that followed `hops` and read `page` at the last one. */
function observed(hops: Hop[], page: string | null, overrides: Partial<SiteObservation> = {}) {
  const last = hops.at(-1)
  const finalUrl = last?.url ?? ''
  return {
    attempts: 1,
    error: last?.error ?? null,
    finalUrl,
    hops,
    page: page === null ? null : pageSignals(page, finalUrl),
    result: page === null ? 'site_unreachable' : 'page',
    status: last?.status ?? null,
    stubs: [],
    website: hops[0]?.url ?? '',
    ...overrides
  } satisfies SiteObservation
}

/** serp.ly answers with a page that redirects on the client, then the product's hops. */
const viaSerpLy = (...hops: Hop[]): Hop[] => [
  { url: 'https://serp.ly/acme', status: 200 },
  { url: 'https://serp.ly/acme', status: 200, location: hops[0]?.url ?? '', client: true },
  ...hops
]

describe('listing domain classifier', () => {
  it('names hijacked gambling pages, on another domain or on the listing’s own', () => {
    // gptservice.app → 8xbet (#98 review): Vietnamese betting.
    expect(
      classifyListing(
        listing(),
        observed(
          viaSerpLy(
            { url: 'https://acme.ai/', status: 301, location: 'https://8xbet.com.es/' },
            { url: 'https://8xbet.com.es/', status: 200 }
          ),
          html(
            '8XBET - Nhà cái cá cược uy tín',
            '<h1>Đăng ký 8xbet</h1><p>Cá cược thể thao, nổ hũ.</p>'
          )
        )
      )
    ).toMatchObject({
      class: 'gambling-spam',
      reason: 'gambling or spam terms in title or heading'
    })
    // A re-registered domain serving togel itself, with no redirect at all.
    expect(
      classifyListing(
        listing(),
        observed(
          viaSerpLy({ url: 'https://acme.ai/', status: 200 }),
          html('Bandar Togel Terpercaya', '<p>Situs slot gacor maxwin hari ini.</p>')
        )
      )
    ).toMatchObject({ class: 'gambling-spam', marker: 'togel' })
    // brandfort.co → situsduniabola.com: one gambling term plus Indonesian gambling-SEO words,
    // which count only off the listing's domain.
    const super33 = html(
      'SUPER33 Daftar Terbaru Platform Games Online Terpercaya',
      '<p>LINK ALTERNATIF RESMI, LOGIN DAN DAFTAR, PENUH KEAJAIBAN SETIAP PUTARAN</p>'
    )
    expect(
      classifyListing(
        listing(),
        observed(
          viaSerpLy(
            { url: 'https://acme.ai/', status: 301, location: 'https://situsduniabola.com/' },
            { url: 'https://situsduniabola.com/', status: 200 }
          ),
          super33
        )
      )
    ).toMatchObject({
      class: 'gambling-spam',
      reason: 'gambling or spam terms in an off-domain page'
    })
    expect(
      classifyListing(
        listing(),
        observed(viaSerpLy({ url: 'https://acme.ai/', status: 200 }), super33)
      ).class
    ).toBe('ok')
    // Some imported descriptions were scraped from the hijacked page; they don't excuse it.
    expect(
      classifyListing(
        listing({ name: 'Phantom', description: '1win Casino: A Comprehensive Guide' }),
        observed(
          viaSerpLy(
            { url: 'https://acme.ai/', status: 301, location: 'https://bwisc.org/' },
            { url: 'https://bwisc.org/', status: 200 }
          ),
          html('8XBET – Nhà Cái Uy Tín Hàng Đầu Châu Á', '<p>Cá cược thể thao.</p>')
        )
      ).class
    ).toBe('gambling-spam')
    // Pharmacy spam on a keyword-hacked page.
    expect(
      classifyListing(
        listing(),
        observed(
          viaSerpLy({ url: 'https://acme.ai/', status: 200 }),
          html('Buy Viagra online', '<p>Cheap cialis and levitra, no prescription.</p>')
        )
      ).class
    ).toBe('gambling-spam')
  })

  it('never calls a legitimate site gambling for mentioning casinos or betting', () => {
    const site = (title: string, body: string) =>
      classifyListing(
        listing(),
        observed(viaSerpLy({ url: 'https://www.acme.ai/', status: 200 }), html(title, body))
      ).class
    expect(
      site(
        'Acme: scheduling for hotels and casinos',
        '<p>Casino floors, resorts, and restaurants use Acme. Casino staff love it.</p>'
      )
    ).toBe('ok')
    // One phrase in the body is an industry list, not a gambling page.
    expect(
      site(
        'Acme AI copywriter',
        '<p>Trusted by retailers, SaaS teams, and online casino affiliates alike.</p>'
      )
    ).toBe('ok')
    expect(site('Acme odds', '<p>Improve the odds of success. Bet on your team.</p>')).toBe('ok')
    // A listing about betting may use betting words: it goes to the owner, never unpublished.
    const betting = classifyListing(
      listing({ name: 'OddsBot', description: 'AI sports betting analytics.' }),
      observed(
        viaSerpLy({ url: 'https://acme.ai/', status: 200 }),
        html('OddsBot: sports betting AI', '<p>Sportsbook odds and betting odds compared.</p>')
      )
    )
    expect(betting.class).toBe('off-domain')
    expect(betting.reason).toContain('owner review')
  })

  it('names parked and for-sale domains by host, title, or provider markup', () => {
    // blockbot.ai, fama.one, flapper.ai: Spaceship's "for sale" page on the domain itself.
    expect(
      classifyListing(
        listing(),
        observed(
          viaSerpLy({ url: 'https://acme.ai/', status: 200 }),
          html('acme.ai is for sale', '<p>Buy now with Spaceship.</p>')
        )
      )
    ).toMatchObject({ class: 'parking', marker: 'is for sale' })
    // outline.ai: a redirect to the Snagged marketplace.
    expect(
      classifyListing(
        listing(),
        observed(
          viaSerpLy(
            {
              url: 'https://acme.ai/',
              status: 302,
              location: 'https://www.snagged.com/domains/acme-ai'
            },
            { url: 'https://www.snagged.com/domains/acme-ai', status: 403, server: 'nginx' }
          ),
          null,
          { result: 'http_403' }
        )
      )
    ).toMatchObject({
      class: 'parking',
      marker: 'snagged.com',
      reason: 'parked or for sale (final host)'
    })
    // GoDaddy's parking stub sends the browser to /lander.
    const stub =
      '<html><body><script>window.onload=function(){window.location.href="/lander"}</script></body></html>'
    expect(
      classifyListing(
        listing(),
        observed(
          viaSerpLy(
            {
              url: 'https://acme.ai/',
              status: 200,
              location: 'https://acme.ai/lander',
              client: true
            },
            { url: 'https://acme.ai/lander', status: 500 }
          ),
          null,
          { result: 'http_500', stubs: [stub] }
        )
      )
    ).toMatchObject({ class: 'parking', marker: 'godaddy /lander' })
  })

  it('counts a parked page only on the listing’s own domain (#104 review)', () => {
    // pandachat.ai: the short link points at dataspot.ai, which is for sale; PandaChat is live.
    const forSale = observed(
      viaSerpLy(
        {
          url: 'https://dataspot.ai/',
          status: 302,
          location: 'https://forsale.godaddy.com/forsale/dataspot.ai'
        },
        { url: 'https://forsale.godaddy.com/forsale/dataspot.ai', status: 403, server: 'nginx' }
      ),
      null,
      { result: 'http_403' }
    )
    const live = observed(
      [{ url: 'https://acme.ai/', status: 200 }],
      html('Acme | A digital twin of your support team', '<p>Acme.</p>')
    )
    const link = classifyListing(listing(), forSale)
    expect(link).toMatchObject({ class: 'off-domain' })
    expect(link.reason).toContain('not the listing')
    expect(classifyListing(listing(), forSale, live)).toMatchObject({ class: 'off-domain' })
    // getoptimal.ai: the link lands on another domain's GoDaddy /lander stub.
    const stub =
      '<html><body><script>window.onload=function(){window.location.href="/lander"}</script></body></html>'
    expect(
      classifyListing(
        listing(),
        observed(
          viaSerpLy(
            {
              url: 'https://tara.ai/',
              status: 200,
              location: 'https://tara.ai/lander',
              client: true
            },
            { url: 'https://tara.ai/lander', status: 200 }
          ),
          html('', ''),
          { stubs: [stub] }
        ),
        live
      ).class
    ).toBe('off-domain')
    // When the listing's own domain is parked too, it is parked, whatever the link does.
    const ownParked = observed(
      [{ url: 'https://acme.ai/', status: 200 }],
      html('acme.ai is for sale', '<p>Buy it.</p>')
    )
    expect(classifyListing(listing(), forSale, ownParked)).toMatchObject({
      class: 'parking',
      reason: 'own domain: parked or for sale (title or heading)',
      source: 'own-domain'
    })
    // banterai.business: the old domain serves gambling, but the link lands on the live company
    // that acquired it. The own domain is the only signal, so the owner decides.
    const acquired = observed(
      viaSerpLy(
        { url: 'https://acme.app/', status: 308, location: 'https://www.0-holdings.com/' },
        { url: 'https://www.0-holdings.com/', status: 200 }
      ),
      html('0 Holdings', '<p>A holding company.</p>')
    )
    const ownGambling = observed(
      [
        { url: 'https://acme.ai/', status: 301, location: 'https://modify.net.nz/' },
        { url: 'https://modify.net.nz/', status: 200 }
      ],
      html('Best online casino bonus', '<p>Gates of Olympus by Pragmatic Play.</p>')
    )
    const decided = classifyListing(listing(), acquired, ownGambling)
    expect(decided).toMatchObject({ class: 'off-domain', source: 'own-domain' })
    expect(decided.reason).toContain('link lands on a live site: owner review')
    // When the link reaches no page at all, the own domain decides.
    const deadLink = observed(viaSerpLy({ url: 'https://acme.app/', error: 'ENOTFOUND' }), null)
    expect(classifyListing(listing(), deadLink, ownGambling)).toMatchObject({
      class: 'gambling-spam',
      source: 'own-domain'
    })
    expect(ownDomainUrl(listing(), forSale)).toBe('https://acme.ai/')
    expect(
      ownDomainUrl(listing(), observed(viaSerpLy({ url: 'https://acme.ai/', status: 200 }), ''))
    ).toBeNull()
    expect(ownDomainUrl(listing({ slug: '123movies-downloader' }), forSale)).toBeNull()
  })

  it('catches the hijacks round 1 missed (#104 review)', () => {
    const offDomain = (url: string, page: string) =>
      classifyListing(
        listing(),
        observed(
          viaSerpLy({ url: 'https://acme.ai/', status: 301, location: url }, { url, status: 200 }),
          page
        )
      )
    // Xoilac soccer-streaming pages that carry betting ads.
    expect(
      offDomain(
        'https://kryptoria.io/',
        html('XoilacTV Trực Tiếp Bóng Đá 24/24 - TTBD Xôi Lạc 90phut #1 VN', '<p>Xem bóng đá.</p>')
      ).class
    ).toBe('gambling-spam')
    // Betting ads only in the markup (image alt text and links).
    expect(
      offDomain(
        'https://stream.example/',
        html(
          'Live football',
          '<a href="https://x.example/"><img alt="nhà cái uy tín"></a><img alt="cá cược thể thao">'
        )
      )
    ).toMatchObject({
      class: 'gambling-spam',
      reason: 'gambling or spam terms in the visible content of an off-domain page'
    })
    // A piracy page full of slot ads.
    expect(
      offDomain(
        'https://acentoenlao.com/',
        html(
          'AnimePlay - Nonton Anime Sub Indo',
          `<p>Episode list</p>${'<img alt="slot">'.repeat(40)}`
        )
      ).class
    ).toBe('gambling-spam')
    // Class names and component markup are not words: a modern app says "slot" in its CSS.
    expect(
      offDomain(
        'https://www.fathom.ai/',
        html(
          'Fathom AI notetaker',
          `<style>${'.slot[data-large-columns="1"]{}'.repeat(60)}</style>${'<div data-slot="card" class="slot">Notes</div>'.repeat(60)}`
        )
      ).class
    ).toBe('off-domain')
    // The same counts on the listing's own domain are not enough.
    expect(
      classifyListing(
        listing(),
        observed(
          viaSerpLy({ url: 'https://acme.ai/', status: 200 }),
          html('Acme booking', `<p>${'Pick a slot. '.repeat(40)}</p>`)
        )
      ).class
    ).toBe('ok')
    // roboweb.app: GERBANGWIN on its own domain.
    expect(
      classifyListing(
        listing(),
        observed(
          viaSerpLy({ url: 'https://acme.ai/', status: 200 }),
          html('GERBANGWIN Fitur AI Cerdas Acme', '<p>Akses praktis melalui link resmi.</p>')
        )
      ).class
    ).toBe('gambling-spam')
    // siddharthverma.in: an expireddomains.com listing, through the listing's own domain.
    expect(
      classifyListing(
        listing(),
        observed(
          viaSerpLy(
            {
              url: 'https://acme.ai/',
              status: 302,
              location: 'https://member.expireddomains.net/x'
            },
            { url: 'https://member.expireddomains.net/x', status: 200 }
          ),
          html('Domain', '')
        )
      ).class
    ).toBe('parking')
    // magician.design: a redirect chain that runs out is not judged by where it stopped.
    expect(
      classifyListing(
        listing(),
        observed(
          viaSerpLy(
            { url: 'https://acme.ai/', status: 301, location: 'https://a.example/' },
            { url: 'https://landsharkspizza.com/', status: 301, location: 'https://b.example/' }
          ),
          null,
          { result: 'too_many_redirects' }
        )
      ).class
    ).toBe('unreachable')
    // typli.ai (an affiliate offer) and sharefable.com (a bare IP) stay with the owner.
    expect(
      offDomain('https://www.claudiacaldwell.com/oto', html('Secret Gift For You', '<p>STOP!</p>'))
        .class
    ).toBe('off-domain')
    expect(
      offDomain('http://172.235.245.66/', html('WOE! SSL Jangan Lupa Di-install!', '')).class
    ).toBe('off-domain')
  })

  it('keeps "for sale" in a page body, and domain tools, out of the parking class', () => {
    expect(
      classifyListing(
        listing(),
        observed(
          viaSerpLy({ url: 'https://acme.ai/', status: 200 }),
          html(
            'Acme storefronts',
            '<p>List products for sale. This domain is for sale? No: yours.</p>'
          )
        )
      ).class
    ).toBe('ok')
    const tool = classifyListing(
      listing({ name: 'NameSpark', description: 'Finds an available domain name with AI.' }),
      observed(
        viaSerpLy({ url: 'https://acme.ai/', status: 200 }),
        html('Domain name is available: register it now', '<p>NameSpark domain search.</p>')
      )
    )
    expect(tool.class).toBe('off-domain')
    expect(tool.reason).toContain('owner review')
  })

  it('treats www, https, and affiliate hops as the same site, and another company as off-domain', () => {
    const page = html('Acme', '<p>Acme writes copy.</p>')
    // http → https and apex → www stay on the listing's registrable domain.
    expect(
      classifyListing(
        listing(),
        observed(
          viaSerpLy(
            { url: 'http://acme.ai/', status: 301, location: 'https://acme.ai/' },
            { url: 'https://acme.ai/', status: 308, location: 'https://www.acme.ai/' },
            { url: 'https://www.acme.ai/', status: 200 }
          ),
          page
        )
      ).class
    ).toBe('ok')
    expect(
      classifyListing(
        listing(),
        observed(
          viaSerpLy(
            { url: 'https://www.acme.ai/', status: 301, location: 'https://acme.ai/' },
            { url: 'https://acme.ai/', status: 200 }
          ),
          page
        )
      ).class
    ).toBe('ok')
    // An affiliate network on the way, a store page, and SERP's own downloader site are fine.
    expect(
      classifyListing(
        listing(),
        observed(
          viaSerpLy(
            { url: 'https://acme.sjv.io/c/1', status: 302, location: 'https://acme.ai/?irclick=1' },
            { url: 'https://acme.ai/?irclick=1', status: 200 }
          ),
          page
        )
      ).class
    ).toBe('ok')
    expect(
      classifyListing(
        listing(),
        observed(
          viaSerpLy(
            {
              url: 'https://acme.ai/',
              status: 301,
              location: 'https://chromewebstore.google.com/detail/acme/x'
            },
            { url: 'https://chromewebstore.google.com/detail/acme/x', status: 200 }
          ),
          page
        )
      ).class
    ).toBe('ok')
    expect(
      classifyListing(
        listing({ slug: '123movies-downloader', website: 'https://serp.ly/123movies-downloader' }),
        observed(
          [
            { url: 'https://serp.ly/123movies-downloader', status: 200 },
            {
              url: 'https://serp.ly/123movies-downloader',
              status: 200,
              location: 'https://serp.co/products/123movies-downloader/',
              client: true
            },
            { url: 'https://serp.co/products/123movies-downloader/', status: 200 }
          ],
          page
        )
      ).class
    ).toBe('ok')
    // gretel.ai → NVIDIA: an acquisition goes to the owner, not to the unpublish list.
    expect(
      classifyListing(
        listing(),
        observed(
          viaSerpLy(
            { url: 'https://acme.ai/', status: 301, location: 'https://www.nvidia.com/en-us/x/' },
            { url: 'https://www.nvidia.com/en-us/x/', status: 200 }
          ),
          html('NVIDIA synthetic data', '<p>Generate data.</p>')
        )
      )
    ).toMatchObject({ class: 'off-domain', reason: 'ends on nvidia.com, not acme.ai' })
  })

  it('separates unreachable sites from bot protection', () => {
    const failed = (hop: Hop, result: SiteObservation['result']) =>
      classifyListing(listing(), observed(viaSerpLy(hop), null, { result })).class
    expect(failed({ url: 'https://acme.ai/', error: 'ENOTFOUND' }, 'site_unreachable')).toBe(
      'unreachable'
    )
    expect(failed({ url: 'https://acme.ai/', status: 503, server: 'nginx' }, 'http_503')).toBe(
      'unreachable'
    )
    expect(failed({ url: 'https://acme.ai/', status: 403, server: 'nginx' }, 'http_403')).toBe(
      'unreachable'
    )
    expect(failed({ url: 'https://acme.ai/', status: 403, server: 'cloudflare' }, 'http_403')).toBe(
      'ok'
    )
    expect(failed({ url: 'https://acme.ai/', status: 403, challenge: true }, 'http_403')).toBe('ok')
  })

  it('expects the slug’s domain, or the first hop past shorteners when the slug is a name', () => {
    expect(registrableDomain('www.app.acme.co.uk')).toBe('acme.co.uk')
    expect(registrableDomain('acme.vercel.app')).toBe('acme.vercel.app')
    expect(expectedDomain(listing({ slug: 'acme.ai' }), [])).toBe('acme.ai')
    expect(
      expectedDomain(listing({ slug: 'serp-notes' }), [
        { url: 'https://serp.ly/notes', status: 200 },
        { url: 'https://bit.ly/x', status: 301 },
        { url: 'https://notes.serp.co/', status: 200 }
      ])
    ).toBe('serp.co')
  })
})

describe('listing domain fetch', () => {
  const page = (body: string, init: ResponseInit = {}) =>
    new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' }, ...init })
  const redirect = (location: string, status = 301) =>
    new Response(null, { headers: { location }, status })

  it('follows long redirect chains, client redirects, and records every hop', async () => {
    const answers: Record<string, () => Response> = {
      'https://serp.ly/acme': () =>
        page('<meta http-equiv="refresh" content="0;url=https://acme.ai/">'),
      'https://acme.ai/': () => redirect('https://www.acme.ai/'),
      'https://www.acme.ai/': () => redirect('https://a.example.com/'),
      'https://a.example.com/': () => redirect('https://b.example.com/'),
      'https://b.example.com/': () => redirect('https://c.example.com/'),
      'https://c.example.com/': () => redirect('https://d.example.com/'),
      'https://d.example.com/': () => page(html('Landing', '<p>Hello</p>'))
    }
    const seen: string[] = []
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      seen.push(new Headers(init?.headers).get('user-agent') ?? '')
      const answer = answers[url]
      if (!answer) throw new Error(`unexpected ${url}`)
      return answer()
    }) as typeof fetch
    const trace = await traceWebsite('https://serp.ly/acme', { fetcher })
    expect(trace.result).toBe('page')
    expect(trace.finalUrl).toBe('https://d.example.com/')
    expect(trace.hops.map(hop => [hop.url, hop.status, hop.client ?? false])).toEqual([
      ['https://serp.ly/acme', 200, false],
      ['https://serp.ly/acme', 200, true],
      ['https://acme.ai/', 301, false],
      ['https://www.acme.ai/', 301, false],
      ['https://a.example.com/', 301, false],
      ['https://b.example.com/', 301, false],
      ['https://c.example.com/', 301, false],
      ['https://d.example.com/', 200, false]
    ])
    expect(trace.page?.title).toBe('Landing')
    expect(new Set(seen)).toEqual(new Set([DOMAIN_CHECK_USER_AGENT]))
  })

  it('retries transient failures, and not permanent ones', async () => {
    const sleep = vi.fn(async () => undefined)
    let calls = 0
    const flaky = (async () => {
      calls += 1
      return calls === 1 ? new Response('busy', { status: 503 }) : page(html('Up', ''))
    }) as typeof fetch
    const recovered = await traceWebsite('https://acme.ai/', { fetcher: flaky, sleep })
    expect(recovered).toMatchObject({ attempts: 2, result: 'page' })
    expect(sleep).toHaveBeenCalledTimes(1)

    const missing = (async () => {
      throw Object.assign(new Error('getaddrinfo ENOTFOUND acme.ai'), { code: 'ENOTFOUND' })
    }) as typeof fetch
    const gone = await traceWebsite('https://acme.ai/', { fetcher: missing, sleep })
    expect(gone).toMatchObject({ attempts: 1, error: 'ENOTFOUND', result: 'site_unreachable' })
  })

  it('refuses private targets, other ports, and names that resolve privately', async () => {
    const fetcher = (async () => redirect('http://127.0.0.1/admin')) as typeof fetch
    const trace = await traceWebsite('https://acme.ai/', { fetcher })
    expect(trace.result).toBe('invalid_target')
    expect(trace.hops.map(hop => hop.url)).toEqual(['https://acme.ai/'])
    await expect(guardedFetch('https://example.com:8443/')).rejects.toMatchObject({ code: 'EPORT' })
    await expect(guardedFetch('ftp://example.com/')).rejects.toMatchObject({ code: 'EPORT' })
    // Node skips the lookup hook for IP literals, so the fetcher checks them itself.
    for (const url of ['http://127.0.0.1/', 'http://[::1]/', 'http://169.254.169.254/'])
      await expect(guardedFetch(url), url).rejects.toMatchObject({ code: 'EBLOCKED' })
    for (const address of [
      '10.0.0.1',
      '127.0.0.1',
      '169.254.169.254',
      '192.168.1.1',
      '::1',
      'fd00::1'
    ])
      expect(isPublicAddress(address), address).toBe(false)
    for (const address of ['8.8.8.8', '2606:4700::1111'])
      expect(isPublicAddress(address)).toBe(true)
    const code = await new Promise(resolveCode =>
      vettedLookup('localhost', { all: true }, error =>
        resolveCode((error as { code?: string } | null)?.code)
      )
    )
    expect(code).toBe('EBLOCKED')
  })

  it('finds meta-refresh and script-only redirects, never a script on a full page', () => {
    expect(
      clientRedirect('<meta http-equiv="refresh" content="0; URL=\'/next\'">', 'https://a.example/')
    ).toBe('https://a.example/next')
    expect(
      clientRedirect(
        '<script>location.replace("https://b.example/")</script>',
        'https://a.example/'
      )
    ).toBe('https://b.example/')
    const full = `<p>${'Real content. '.repeat(40)}</p><script>location.href="https://b.example/"</script>`
    expect(clientRedirect(full, 'https://a.example/')).toBeNull()
    expect(
      clientRedirect(
        '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">',
        'https://a.example/'
      )
    ).toBeNull()
  })
})

describe('listing domain report and manifest', () => {
  const catalog: CatalogListing[] = [
    { ...listing(), categories: ['ai-writing'] },
    {
      ...listing({ id: 'lst_fixture00002', slug: 'bravo.io', website: 'https://serp.ly/bravo' }),
      categories: ['seo', 'ai-writing']
    },
    {
      ...listing({ id: 'lst_fixture00003', slug: 'carta.app', website: 'https://serp.ly/carta' }),
      categories: ['seo']
    }
  ]
  const checked = [
    {
      listing: catalog[0] as CatalogListing,
      observation: observed(
        viaSerpLy({ url: 'https://acme.ai/', status: 200 }),
        html('acme.ai is for sale', '')
      )
    },
    {
      listing: catalog[1] as CatalogListing,
      observation: observed(viaSerpLy({ url: 'https://bravo.io/', error: 'ENOTFOUND' }), null)
    },
    {
      listing: catalog[2] as CatalogListing,
      observation: observed(
        viaSerpLy({ url: 'https://carta.app/', status: 200 }),
        html('Carta', '<p>Fine.</p>')
      )
    }
  ]
  const report = buildReport(checked, '2026-10-06T00:00:00.000Z', 'fixture')

  it('splits the unpublish list from the owner list and counts every class', () => {
    expect(report.counts).toEqual({
      'gambling-spam': 0,
      parking: 1,
      'off-domain': 0,
      unreachable: 1,
      ok: 1
    })
    expect(report.unpublish.map(entry => entry.slug)).toEqual(['acme.ai'])
    expect(report.ownerReview).toEqual([
      expect.objectContaining({ class: 'unreachable', slug: 'bravo.io', status: 'ENOTFOUND' })
    ])
  })

  it('writes a manifest the publisher accepts, guarded by each listing’s website', () => {
    const source = buildUnpublishManifest(report, catalog, {
      id: '2026-10-06-hijacked-domains',
      reportPath: 'd1/hygiene/x.yaml'
    })
    // Row-level: no base version, so it fits staging and production in any order.
    expect(parseManifest(source)).toMatchObject({ concurrency: 'rows' })
    expect(parseManifest(source).basePublicationVersion).toBeUndefined()
    expect(parseManifest(source).operations).toEqual([
      {
        action: 'listing-unpublish',
        categories: ['ai-writing'],
        expected: { website: 'https://serp.ly/acme' },
        id: 'lst_fixture00001',
        reason: '#100 hijacked domain, parked or for sale: is for sale',
        slug: 'acme.ai'
      }
    ])
    const moved = catalog.map(entry =>
      entry.id === 'lst_fixture00001' ? { ...entry, website: 'https://acme.ai/' } : entry
    )
    expect(() =>
      buildUnpublishManifest(report, moved, {
        id: 'x-hijacked-domains',
        reportPath: 'x'
      })
    ).toThrow('no longer matches')
  })

  it('parses its arguments strictly', () => {
    expect(parseArguments(['--', 'manifest', '--date', '2026-10-06'])).toMatchObject({
      command: 'manifest',
      date: '2026-10-06'
    })
    expect(() => parseArguments(['--date', '6/10/2026'])).toThrow('YYYY-MM-DD')
    expect(() => parseArguments(['--concurrency', '0'])).toThrow('1 to 32')
    expect(() => parseArguments(['--site', 'x'])).toThrow('Unknown argument')
    expect(
      parseArguments(['dead-manifest', '--date', '2026-10-07', '--since', '2026-10-06'])
    ).toMatchObject({ command: 'dead-manifest', date: '2026-10-07', since: '2026-10-06' })
    expect(() => parseArguments(['dead-manifest', '--date', '2026-10-07'])).toThrow('--since')
  })

  it('unpublishes a domain only when it does not exist in both checks (#104)', () => {
    const cartaFailing = (error: string) => ({
      listing: catalog[2] as CatalogListing,
      observation: observed(viaSerpLy({ url: 'https://carta.app/', error }), null)
    })
    // bravo.io does not exist in either check: dead. carta.app did not exist, then answered with a
    // reset (an outage, or a different failure): never dead.
    const earlier = buildReport(
      [checked[1], cartaFailing('ENOTFOUND')] as Parameters<typeof buildReport>[0],
      '2026-10-06T00:00:00.000Z',
      'fixture'
    )
    const later = buildReport(
      [checked[1], cartaFailing('ECONNRESET')] as Parameters<typeof buildReport>[0],
      '2026-10-07T00:00:00.000Z',
      'fixture'
    )
    expect(deadDomainEntries(earlier, later).map(entry => entry.slug)).toEqual(['bravo.io'])
    // A website changed between the checks is a different listing: never dead.
    const moved = {
      ...later,
      ownerReview: later.ownerReview.map(entry => ({ ...entry, website: 'https://bravo.io/' }))
    }
    expect(deadDomainEntries(earlier, moved)).toEqual([])
    const source = buildDeadDomainManifest(earlier, later, catalog, {
      earlierPath: 'a.yaml',
      id: '2026-10-07-dead-domains',
      recheckPath: 'b.yaml'
    })
    expect(parseManifest(source)).toMatchObject({ concurrency: 'rows' })
    expect(parseManifest(source).operations).toEqual([
      {
        action: 'listing-unpublish',
        categories: ['seo', 'ai-writing'],
        expected: { website: 'https://serp.ly/bravo' },
        id: 'lst_fixture00002',
        reason:
          '#104 dead domain: bravo.io does not exist (DNS), checked 2026-10-06 and 2026-10-07',
        slug: 'bravo.io'
      }
    ])
    expect(() =>
      buildDeadDomainManifest(earlier, moved, catalog, {
        earlierPath: 'a',
        id: 'x-dead-domains',
        recheckPath: 'b'
      })
    ).toThrow('nothing to unpublish')
  })

  it('keeps each committed dead-domain manifest identical to its two committed checks', () => {
    const manifests = readdirSync(resolve('d1/publications')).filter(file =>
      file.endsWith('-dead-domains.yaml')
    )
    const listings = reviewedImportListings()
    for (const file of manifests) {
      const source = readFileSync(resolve('d1/publications', file), 'utf8')
      const manifest = parseManifest(source)
      const [, earlierPath, recheckPath] = source.match(/^# Evidence: (\S+) and (\S+)\.$/mu) ?? []
      expect(recheckPath, file).toBe(recheckPathFor(file.slice(0, 10)))
      const read = (path: string) =>
        parse(readFileSync(resolve(path as string), 'utf8')) as DomainReport
      expect(source, file).toBe(
        buildDeadDomainManifest(read(earlierPath), read(recheckPath), listings, {
          earlierPath: earlierPath as string,
          id: manifest.id,
          recheckPath: recheckPath as string
        })
      )
      // It applies, whole, to the reviewed catalog both environments started from.
      const database = new DatabaseSync(':memory:')
      for (const migration of freshMigrationNames())
        database.exec(readFileSync(resolve(freshMigrationsDirectory, migration), 'utf8'))
      database.exec(readReviewedImportSql(readParityReport()))
      const live = database
        .prepare('SELECT version, checksum FROM publication_state WHERE id = 1')
        .get() as { checksum: string; version: number }
      const plan = buildPublicationPlan(manifest, source, '2026-10-07T00:00:00.000Z', live)
      database.exec('BEGIN')
      for (const item of plan.statements) {
        assertD1StatementLimits(item.query, item.bindings)
        database
          .prepare(item.query)
          .run(
            ...(item.bindings.map(value =>
              typeof value === 'boolean' ? Number(value) : value
            ) as SQLInputValue[])
          )
      }
      database.exec('COMMIT')
      expect(
        database
          .prepare(`SELECT COUNT(*) AS count FROM listings WHERE status='approved' AND is_active=0`)
          .get()
      ).toEqual({ count: manifest.operations.length })
      database.close()
    }
  }, 60_000)

  it('keeps the committed manifest identical to the committed report and the reviewed catalog', () => {
    const reports = existsSync(resolve('d1/hygiene'))
      ? readdirSync(resolve('d1/hygiene')).filter(file => file.endsWith('-listing-domains.yaml'))
      : []
    expect(reports.length).toBeGreaterThan(0)
    const listings = reviewedImportListings()
    for (const file of reports) {
      const date = file.slice(0, 10)
      const committed = parse(readFileSync(resolve('d1/hygiene', file), 'utf8')) as DomainReport
      const manifestPath = resolve(`d1/publications/${date}-hijacked-domains.yaml`)
      const source = readFileSync(manifestPath, 'utf8')
      const manifest = parseManifest(source)
      // The manifest is exactly what the generator writes from the report and the catalog.
      expect(source, file).toBe(
        buildUnpublishManifest(committed, listings, {
          id: manifest.id,
          reportPath: `d1/hygiene/${file}`
        })
      )
      // It applies, whole, to the reviewed catalog both environments started from.
      const database = new DatabaseSync(':memory:')
      for (const migration of freshMigrationNames())
        database.exec(readFileSync(resolve(freshMigrationsDirectory, migration), 'utf8'))
      database.exec(readReviewedImportSql(readParityReport()))
      // Row-level: planned at the environment's live state, here the import's.
      const live = database
        .prepare('SELECT version, checksum FROM publication_state WHERE id = 1')
        .get() as { checksum: string; version: number }
      const plan = buildPublicationPlan(manifest, source, '2026-10-06T00:00:00.000Z', live)
      database.exec('BEGIN')
      for (const item of plan.statements) {
        assertD1StatementLimits(item.query, item.bindings)
        const bindings = item.bindings.map(value =>
          typeof value === 'boolean' ? Number(value) : value
        ) as SQLInputValue[]
        database.prepare(item.query).run(...bindings)
      }
      database.exec('COMMIT')
      const ids = manifest.operations.map(operation => ('id' in operation ? operation.id : ''))
      expect(
        database
          .prepare(
            `SELECT COUNT(*) AS count FROM listings WHERE status='approved' AND is_active=0 AND id IN (${ids.map(() => '?').join(',')})`
          )
          .get(...ids)
      ).toEqual({ count: committed.unpublish.length })
      expect(database.prepare('SELECT COUNT(*) AS count FROM listing_events').get()).toEqual({
        count: committed.unpublish.length
      })
      expect(database.prepare('SELECT version FROM publication_state').get()).toEqual({
        version: live.version + 1
      })
      database.close()
      expect(
        committed.unpublish.every(entry => ['parking', 'gambling-spam'].includes(entry.class))
      ).toBe(true)
      expect(
        committed.ownerReview.some(entry => ['parking', 'gambling-spam'].includes(entry.class))
      ).toBe(false)
    }
  })

  it('unpublishes the owner’s decisions, each with its class and reason (#104)', () => {
    const decisions: OwnerListDecisions = {
      decidedAt: '2026-10-07',
      evidence: [],
      unpublish: [
        {
          class: 'gone',
          id: 'lst_fixture00002',
          reason: 'site does not work',
          slug: 'bravo.io',
          website: 'https://serp.ly/bravo'
        }
      ]
    }
    const source = buildDecisionsManifest(decisions, catalog, {
      decisionsPath: 'd.yaml',
      id: '2026-10-07-owner-list-cleanup'
    })
    expect(parseManifest(source).operations).toEqual([
      {
        action: 'listing-unpublish',
        categories: ['seo', 'ai-writing'],
        expected: { website: 'https://serp.ly/bravo' },
        id: 'lst_fixture00002',
        reason: '#104 gone: site does not work',
        slug: 'bravo.io'
      }
    ])
    const wrongClass = {
      ...decisions,
      unpublish: [{ ...decisions.unpublish[0], class: 'meh' }]
    } as unknown as OwnerListDecisions
    expect(() =>
      buildDecisionsManifest(wrongClass, catalog, { decisionsPath: 'd', id: 'x' })
    ).toThrow('gone or trash')
  })

  it('keeps each committed owner-list cleanup identical to its decisions, and disjoint from other unpublications', () => {
    const publications = readdirSync(resolve('d1/publications'))
    const unpublished = new Map<string, string>()
    for (const file of publications) {
      if (file.endsWith('-owner-list-cleanup.yaml')) continue
      const manifest = parseManifest(readFileSync(resolve('d1/publications', file), 'utf8'))
      for (const operation of manifest.operations)
        if (operation.action === 'listing-unpublish') unpublished.set(operation.id, file)
    }
    const listings = reviewedImportListings()
    for (const file of publications.filter(name => name.endsWith('-owner-list-cleanup.yaml'))) {
      const source = readFileSync(resolve('d1/publications', file), 'utf8')
      const manifest = parseManifest(source)
      const decisionsPath = decisionsPathFor(file.slice(0, 10))
      const decisions = parse(readFileSync(resolve(decisionsPath), 'utf8')) as OwnerListDecisions
      expect(source, file).toBe(
        buildDecisionsManifest(decisions, listings, { decisionsPath, id: manifest.id })
      )
      // Another manifest's unpublish would leave the listing not live, and this one refuses whole.
      for (const operation of manifest.operations)
        expect(unpublished.get(operation.id), operation.slug).toBeUndefined()
      const database = new DatabaseSync(':memory:')
      for (const migration of freshMigrationNames())
        database.exec(readFileSync(resolve(freshMigrationsDirectory, migration), 'utf8'))
      database.exec(readReviewedImportSql(readParityReport()))
      const live = database
        .prepare('SELECT version, checksum FROM publication_state WHERE id = 1')
        .get() as { checksum: string; version: number }
      const plan = buildPublicationPlan(manifest, source, '2026-10-07T00:00:00.000Z', live)
      database.exec('BEGIN')
      for (const item of plan.statements) {
        assertD1StatementLimits(item.query, item.bindings)
        database
          .prepare(item.query)
          .run(
            ...(item.bindings.map(value =>
              typeof value === 'boolean' ? Number(value) : value
            ) as SQLInputValue[])
          )
      }
      database.exec('COMMIT')
      expect(
        database
          .prepare(`SELECT COUNT(*) AS count FROM listings WHERE status='approved' AND is_active=0`)
          .get()
      ).toEqual({ count: manifest.operations.length })
      database.close()
    }
  }, 60_000)
})
