import { describe, expect, it } from 'vitest'
import {
  domainPinnedFetcher,
  metaRefreshTarget,
  productSite,
  safeResolveLanding,
  storedProductSite
} from './product'

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
  it('uses the slug’s domain, or the website when it is the product’s own', () => {
    expect(storedProductSite({ slug: 'jasper.ai', website: 'https://serp.ly/jasper' })).toEqual({
      domain: 'jasper.ai',
      url: 'https://jasper.ai/'
    })
    expect(
      storedProductSite({ slug: 'app.brieflow.ai', website: 'http://app.brieflow.ai:8080/x' })
    ).toEqual({ domain: 'brieflow.ai', url: 'http://app.brieflow.ai:8080/x' })
    expect(storedProductSite({ slug: 'notion', website: 'https://www.notion.so/' })).toEqual({
      domain: 'notion.so',
      url: 'https://www.notion.so/'
    })
    // SERP's domains and link shorteners are never the product's.
    expect(storedProductSite({ slug: 'notion', website: 'https://serp.ly/notion' })).toBeNull()
    expect(storedProductSite({ slug: 'serp.co', website: 'https://bit.ly/x' })).toBeNull()
  })

  it('follows a serp.ly link’s meta refresh to the landing page through the safe fetcher', async () => {
    const web = fakeWeb({
      'https://serp.ly/notion': { body: refresh('https://www.notion.com/?fpr=devin') },
      'https://www.notion.com/?fpr=devin': { body: '<html><body>Notion</body></html>' }
    })
    const resolve = safeResolveLanding(web.fetcher)
    await expect(
      productSite({ slug: 'notion', website: 'https://serp.ly/notion' }, resolve)
    ).resolves.toEqual({ domain: 'notion.com', url: 'https://www.notion.com/' })
    // A slug domain needs no network.
    await productSite({ slug: 'jasper.ai', website: 'https://serp.ly/jasper' }, resolve)
    expect(web.requested).toEqual(['https://serp.ly/notion', 'https://www.notion.com/?fpr=devin'])
  })

  it('finds no product domain when the link fails or lands on SERP or a shortener', async () => {
    const web = fakeWeb({
      'https://serp.ly/a': { body: refresh('https://serp.co/products/a/') },
      'https://serp.co/products/a/': { body: '<html></html>' },
      'https://serp.ly/b': { body: refresh('https://bit.ly/zz') },
      'https://bit.ly/zz': { body: '<html></html>' }
    })
    const resolve = safeResolveLanding(web.fetcher)
    for (const website of ['https://serp.ly/a', 'https://serp.ly/b', 'https://serp.ly/missing']) {
      await expect(productSite({ slug: 'x', website }, resolve), website).resolves.toBeNull()
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
