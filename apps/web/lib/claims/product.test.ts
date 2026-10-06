import { describe, expect, it } from 'vitest'
import { domainPinnedFetcher, metaRefreshTarget, productSite, safeResolveLanding } from './product'

/** A fake web: `serp.ly` answers with a meta refresh (as Short.io does), the rest with pages. */
function fakeWeb(pages: Record<string, { body?: string; location?: string; status?: number }>) {
  const requested: string[] = []
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = String(input)
    requested.push(url)
    const page = pages[url]
    if (!page) return new Response('not found', { status: 404 })
    return new Response(page.body ?? '', {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        ...(page.location ? { location: page.location } : {})
      },
      status: page.status ?? 200
    })
  }) as typeof fetch
  return { fetcher, requested }
}

const refresh = (target: string) =>
  `<!doctype html><html><head><meta http-equiv="refresh" content="0; url=${target}"></head></html>`

describe('the product’s own site', () => {
  const offline: Parameters<typeof productSite>[1] = async () => {
    throw new Error('no network expected')
  }

  it('uses a website on the product’s own domain, when the slug agrees', async () => {
    await expect(
      productSite({ slug: 'app.brieflow.ai', website: 'http://app.brieflow.ai:8080/x' }, offline)
    ).resolves.toEqual({
      ok: true,
      site: { domain: 'brieflow.ai', url: 'http://app.brieflow.ai:8080/x' }
    })
    await expect(
      productSite({ slug: 'notion', website: 'https://www.notion.so/' }, offline)
    ).resolves.toEqual({ ok: true, site: { domain: 'notion.so', url: 'https://www.notion.so/' } })
    // A slug domain that isn't the website's: the owner reviews it.
    await expect(
      productSite({ slug: 'notion.com', website: 'https://www.notion.so/' }, offline)
    ).resolves.toEqual({ ok: false, reason: 'review' })
  })

  it('follows a serp.ly link’s meta refresh chain to the landing page through the safe fetcher', async () => {
    const big = `<html><body>${'x'.repeat(600_000)}</body></html>`
    const web = fakeWeb({
      'https://serp.ly/jasper': { body: refresh('https://www.jasper.ai/?fpr=devin') },
      // Real homepages are large: past the old 256 KB cap.
      'https://www.jasper.ai/?fpr=devin': { body: big },
      'https://serp.ly/notion': { body: refresh('https://hop.example/one') },
      'https://hop.example/one': { body: refresh('https://www.notion.com/') },
      'https://www.notion.com/': {
        body: '<html><!-- <meta http-equiv="refresh" content="0; url=https://evil.example/"> --></html>'
      }
    })
    const resolve = safeResolveLanding(web.fetcher)
    await expect(
      productSite({ slug: 'jasper.ai', website: 'https://serp.ly/jasper' }, resolve)
    ).resolves.toEqual({ ok: true, site: { domain: 'jasper.ai', url: 'https://www.jasper.ai/' } })
    await expect(
      productSite({ slug: 'notion', website: 'https://serp.ly/notion' }, resolve)
    ).resolves.toEqual({ ok: true, site: { domain: 'notion.com', url: 'https://www.notion.com/' } })
  })

  it('sends a disagreeing or unresolvable link to the owner’s review', async () => {
    const web = fakeWeb({
      // The slug's domain lapsed: the link now lands on someone else's site (#100 off-domain).
      'https://serp.ly/babbl': { body: refresh('https://babbl-labs.com/') },
      'https://babbl-labs.com/': { body: '<html></html>' },
      // A destination that refuses our checker, or doesn't exist (an unregistered domain).
      'https://serp.ly/refused': { body: refresh('https://refused.example/') },
      'https://refused.example/': { body: 'no', status: 403 },
      'https://serp.ly/codementorgpt': { body: refresh('https://codementorgpt.com/') },
      // A chain that never ends.
      'https://serp.ly/loop': { body: refresh('https://a.example/') },
      'https://a.example/': { body: refresh('https://serp.ly/loop') }
    })
    const resolve = safeResolveLanding(web.fetcher)
    for (const [slug, website] of [
      ['babbl.dev', 'https://serp.ly/babbl'],
      ['refused.example', 'https://serp.ly/refused'],
      ['codementorgpt.com', 'https://serp.ly/codementorgpt'],
      ['loop-tool', 'https://serp.ly/loop']
    ] as const) {
      await expect(productSite({ slug, website }, resolve), slug).resolves.toEqual({
        ok: false,
        reason: 'review'
      })
    }
  })

  it('finds no product domain when a name slug’s link lands on SERP or a shortener', async () => {
    const web = fakeWeb({
      'https://serp.ly/a': { body: refresh('https://serp.co/products/a/') },
      'https://serp.co/products/a/': { body: '<html></html>' },
      'https://serp.ly/b': { body: refresh('https://bit.ly/zz') },
      'https://bit.ly/zz': { body: '<html></html>' }
    })
    const resolve = safeResolveLanding(web.fetcher)
    for (const website of ['https://serp.ly/a', 'https://serp.ly/b']) {
      await expect(productSite({ slug: 'x', website }, resolve), website).resolves.toEqual({
        ok: false,
        reason: 'none'
      })
    }
  })

  it('reads a refresh target the way the classifier does', () => {
    expect(metaRefreshTarget(refresh('/next?a=1&amp;b=2'), 'https://serp.ly/x')).toBe(
      'https://serp.ly/next?a=1&b=2'
    )
    expect(
      metaRefreshTarget('<meta name="robots" content="index">', 'https://a.example/')
    ).toBeNull()
  })
})

describe('the badge check’s pinned fetcher', () => {
  it('refuses every request off the claim domain, redirects included', async () => {
    const web = fakeWeb({ 'https://www.jasper.ai/': { body: 'ok' } })
    const pinned = domainPinnedFetcher('jasper.ai', web.fetcher)
    await expect(pinned.fetch('https://www.jasper.ai/')).resolves.toBeInstanceOf(Response)
    expect(pinned.left()).toBe(false)
    await expect(pinned.fetch('https://linktr.ee/jasper')).rejects.toThrow(/left the claim domain/u)
    expect(pinned.left()).toBe(true)
    expect(web.requested).toEqual(['https://www.jasper.ai/'])
  })
})
