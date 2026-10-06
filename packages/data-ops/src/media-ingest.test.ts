import { describe, expect, it } from 'vitest'
import {
  fetchImage,
  ingestImage,
  isRetryableMediaFailure,
  type MediaBucket,
  scopedMediaBucket
} from './media-ingest'
import { MAX_MEDIA_BYTES, MEDIA_CACHE_CONTROL, sha256Hex } from './media-keys'
import { imageResponse, memoryBucket, pngBytes, routedFetch } from './media-test-support'

const source = 'https://assets.example/logo.png'

describe('fetchImage', () => {
  it('recognizes the image by its bytes, whatever the server calls it', async () => {
    const png = pngBytes(400, 300)
    const result = await fetchImage(source, {
      fetcher: routedFetch({ [source]: imageResponse(png, 'application/octet-stream') })
    })
    expect(result).toEqual({
      body: png,
      contentType: 'image/png',
      format: 'png',
      height: 300,
      ok: true,
      sha256: await sha256Hex(png),
      url: source,
      width: 400
    })
  })

  it.each([
    ['an SVG', imageResponse(new TextEncoder().encode('<svg/>'), 'image/svg+xml'), 'svg'],
    [
      'an HTML page',
      new Response('<html>', { headers: { 'Content-Type': 'text/html' } }),
      'unexpected_type'
    ],
    ['an unknown format', imageResponse(new TextEncoder().encode('GIF8 nope')), 'unknown_format'],
    ['a missing image', new Response('no', { status: 404 }), 'http_404'],
    ['a server error', new Response('no', { status: 503 }), 'http_503']
  ])('refuses %s', async (_name, response, code) => {
    const result = await fetchImage(source, { fetcher: routedFetch({ [source]: response }) })
    expect(result).toMatchObject({ code, ok: false })
  })

  it('stops reading past the size cap and refuses images below a minimum size', async () => {
    const big = imageResponse(pngBytes(10, 10, MAX_MEDIA_BYTES))
    expect(await fetchImage(source, { fetcher: routedFetch({ [source]: big }) })).toMatchObject({
      code: 'response_too_large',
      ok: false
    })
    const small = imageResponse(pngBytes(16, 16))
    expect(
      await fetchImage(source, { fetcher: routedFetch({ [source]: small }), minPixels: 32 })
    ).toMatchObject({ code: 'image_too_small', ok: false })
  })

  it('follows redirects only to public URLs', async () => {
    const redirect = (location: string) =>
      new Response(null, { headers: { Location: location }, status: 302 })
    const cdn = 'https://cdn.assets.example/logo.png'
    const ok = await fetchImage(source, {
      fetcher: routedFetch({ [source]: redirect(cdn), [cdn]: imageResponse(pngBytes(64, 64)) })
    })
    expect(ok).toMatchObject({ ok: true, url: cdn })
    const internal = await fetchImage(source, {
      fetcher: routedFetch({ [source]: redirect('http://169.254.169.254/latest/meta-data') })
    })
    expect(internal).toMatchObject({ code: 'invalid_target', ok: false })
    expect(await fetchImage('http://localhost/logo.png')).toMatchObject({
      code: 'invalid_target',
      ok: false
    })
  })

  it('retries only failures the source may recover from', () => {
    for (const code of [
      'fetch_timeout',
      'site_unreachable',
      'http_503',
      'http_429',
      'store_failed'
    ] as const) {
      expect(isRetryableMediaFailure(code), code).toBe(true)
    }
    for (const code of [
      'http_404',
      'svg',
      'unknown_format',
      'invalid_target',
      'response_too_large'
    ] as const) {
      expect(isRetryableMediaFailure(code), code).toBe(false)
    }
  })
})

describe('ingestImage', () => {
  it('stores the bytes under the content-addressed key with an immutable cache policy', async () => {
    const png = pngBytes(512, 512)
    const sha256 = await sha256Hex(png)
    const bucket = memoryBucket()
    const result = await ingestImage({
      bucket,
      fetcher: routedFetch({ [source]: imageResponse(png) }),
      kind: 'logo',
      slug: 'example.com',
      sourceUrl: source
    })
    const key = `best.serp.co/listings/example.com/logo/${sha256.slice(0, 16)}.png`
    expect(result).toEqual({
      media: {
        bytes: png.byteLength,
        contentType: 'image/png',
        height: 512,
        key,
        sha256,
        sourceUrl: source,
        width: 512
      },
      ok: true
    })
    expect(bucket.objects.get(key)).toEqual({
      body: png,
      options: {
        customMetadata: { sha256, source },
        httpMetadata: { cacheControl: MEDIA_CACHE_CONTROL, contentType: 'image/png' },
        sha256
      }
    })
  })

  it('reports a failed write as retryable and never writes outside this site’s keys', async () => {
    const failing: MediaBucket = {
      put: async () => {
        throw new Error('R2 unavailable')
      }
    }
    expect(
      await ingestImage({
        bucket: failing,
        fetcher: routedFetch({ [source]: imageResponse(pngBytes(64, 64)) }),
        kind: 'image',
        slug: 'example.com',
        sourceUrl: source
      })
    ).toEqual({ code: 'store_failed', ok: false, retryable: true })
    const bucket = memoryBucket()
    await expect(
      scopedMediaBucket(bucket).put('serp.co/index.html', new Uint8Array(), {
        httpMetadata: { cacheControl: '', contentType: 'text/html' }
      })
    ).rejects.toThrow(/Refusing/u)
    expect(bucket.objects.size).toBe(0)
  })
})
