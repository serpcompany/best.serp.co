import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { parseManifest } from '../d1-publisher.ts'
import { solidPng } from '../fixtures/solid-png'
import { mediaPlanSchema } from '../media-upload'
import { cachingFetch, classifySource, migrateLegacyMedia, sourceFor } from './legacy-media'

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
 * Every Cloudflare Images source is dead; serp.ly short links refresh to the product page,
 * which declares an apple-touch-icon and an og:image; every other https source is an image.
 */
const stubFetch: typeof fetch = async input => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  if (url.host === 'imagedelivery.net') return new Response('ERROR 9404', { status: 404 })
  if (url.host === 'serp.ly') {
    return html(`<meta http-equiv="refresh" content="0; url=https://product.test${url.pathname}">`)
  }
  if (url.host === 'product.test' && url.pathname.endsWith('/touch.png')) return image(icon)
  if (url.host === 'product.test' && url.pathname.endsWith('/card.png')) return image(social)
  if (url.host === 'product.test') {
    return html(
      `<link rel="icon" type="image/svg+xml" href="/logo.svg"><link rel="apple-touch-icon" href="${url.pathname}/touch.png"><meta property="og:image" content="${url.pathname}/card.png">`
    )
  }
  return image(original)
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

  it('hosts live sources, replaces dead ones from the product site, and chains its manifests', async () => {
    const result = await migrateLegacyMedia({
      fetcher: stubFetch,
      limit: 6,
      listingsPerManifest: 4
    })
    const plan = mediaPlanSchema.parse(result.plan)
    expect(result.outcomes).toHaveLength(6)
    expect(result.manifests.map(manifest => manifest.file)).toEqual([
      'd1/publications/2026-10-06-legacy-media-01.yaml',
      'd1/publications/2026-10-06-legacy-media-02.yaml'
    ])
    const [first, second] = result.manifests.map(manifest => parseManifest(manifest.text))
    expect(first?.basePublicationVersion).toBe(1)
    expect(second?.basePublicationVersion).toBe(2)
    expect(first?.operations).toHaveLength(4)
    // Every dead Cloudflare Images logo was replaced by the product's own icon, never kept.
    for (const outcome of result.outcomes) expect(outcome.logo).not.toBe('dropped')
    const keys = new Set(plan.objects.map(object => object.key))
    for (const manifest of [first, second]) {
      for (const op of manifest?.operations ?? []) {
        if (op.action !== 'listing-media-update') throw new Error('Unexpected operation.')
        for (const hosted of [op.media.logo, ...(op.media.images ?? [])]) {
          if (hosted) expect(keys.has(hosted.key), hosted.key).toBe(true)
        }
        expect(op.expected.length).toBeGreaterThan(0)
      }
    }
    expect(plan.objects.some(object => object.source.startsWith('https://product.test/'))).toBe(
      true
    )
    expect(plan.objects.every(object => !object.source.includes('imagedelivery.net'))).toBe(true)
    expect(result.report).toContain('replaced from the site icon')
  }, 120_000)

  it('replays cached answers, redirects included, without fetching again', async () => {
    let calls = 0
    const counted: typeof fetch = async (input, init) => {
      calls += 1
      return stubFetch(input, init)
    }
    const original = globalThis.fetch
    globalThis.fetch = counted
    try {
      const cached = cachingFetch(cacheDirectory, false)
      const first = await cached('https://serp.ly/x')
      const again = await cached('https://serp.ly/x')
      expect(await first.text()).toBe(await again.text())
      expect(calls).toBe(1)
    } finally {
      globalThis.fetch = original
    }
  })
})
