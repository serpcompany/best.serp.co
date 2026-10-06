import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { solidPng } from './fixtures/solid-png'
import { mediaPlanSchema, type UploadOptions, uploadMediaPlan, verifyObject } from './media-upload'
import { type Clock, type R2CallOptions, RateLimiter } from './r2-objects'

/**
 * The plan under test lives in its own directory, never d1/media: the publisher and the catalog
 * media guard read every plan there while this suite runs in parallel with theirs.
 */
const planDirectory = mkdtempSync(join(tmpdir(), 'media-upload-test-'))
const planPath = join(planDirectory, 'media-upload-test.json')
const fallbackTile = 'apps/web/public/listing-logos/favicon-fallback-512x512.png'
const png = solidPng(64, 32, [1, 2, 3])
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const md5 = (bytes: Uint8Array) => createHash('md5').update(bytes).digest('hex')
const tile = new Uint8Array(readFileSync(resolve(fallbackTile)))

function object(bytes: Uint8Array, source: string, slug: string, width: number, height: number) {
  const sha256 = sha(bytes)
  return {
    bytes: bytes.byteLength,
    contentType: 'image/png',
    height,
    key: `best.serp.co/listings/${slug}/logo/${sha256.slice(0, 16)}.png`,
    md5: md5(bytes),
    sha256,
    source,
    width
  }
}

const remote = object(png, 'https://assets.example/logo.png', 'remote.example', 64, 32)
const repo = object(tile, `repo:${fallbackTile}`, 'repo.example', 512, 512)
const plan = { id: 'media-upload-test', objects: [remote, repo], site: 'best.serp.co', version: 1 }

writeFileSync(planPath, JSON.stringify(plan))
afterAll(() => rmSync(planDirectory, { force: true, recursive: true }))

/** Uploads the test plan from its own directory. */
const upload = (options: UploadOptions) => uploadMediaPlan(planPath, { ...options, planDirectory })

const workflowEnvironment = {
  CI: 'true',
  CLOUDFLARE_ACCOUNT_ID: 'account',
  CLOUDFLARE_API_TOKEN: 'token',
  GITHUB_ACTIONS: 'true',
  GITHUB_REF: 'refs/heads/staging',
  GITHUB_SHA: 'a'.repeat(40),
  GITHUB_WORKFLOW_REF: 'owner/repo/.github/workflows/upload-media-staging.yml@refs/heads/staging',
  MEDIA_UPLOAD_CONFIRM: 'upload-media-best.serp.co-staging'
}

/** A clock that never waits: sleeps only advance it, so retries and the limiter run instantly. */
function fakeClock(): Clock & { slept: number[] } {
  let now = 0
  const slept: number[] = []
  return {
    now: () => now,
    async sleep(ms) {
      slept.push(ms)
      now += ms
    },
    slept
  }
}

/** R2 options for a test: its own limiter on a fake clock, so nothing sleeps for real. */
function fast(clock = fakeClock()): R2CallOptions & { clock: ReturnType<typeof fakeClock> } {
  return { clock, limiter: new RateLimiter(900, 300_000, 10, clock) }
}

const IMMUTABLE = 'public, max-age=31536000, immutable'

/**
 * Sources answer with their bytes; each R2 bucket (`bucket/key` → bytes) answers the list API
 * (`pageSize` objects per page, with a cursor), GETs, and PUTs through the API, like R2: the
 * ETag is the stored bytes' MD5. The first `throttle` R2 calls answer 429 with `Retry-After: 2`.
 * Nothing is read from a media host's CDN.
 */
function fakeFetch(
  buckets: Record<string, Uint8Array> = {},
  sources: Record<string, Uint8Array> = { [remote.source]: png },
  options: { pageSize?: number; throttle?: number } = {}
) {
  const stored = new Map(
    Object.entries(buckets).map(([id, body]) => [
      id,
      { body, cacheControl: IMMUTABLE, type: 'image/png' }
    ])
  )
  let throttle = options.throttle ?? 0
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const api = 'https://api.cloudflare.com/client/v4/accounts/account/r2/buckets/'
    if (url.startsWith(api)) {
      if (throttle > 0) {
        throttle -= 1
        return new Response('rate limited', { headers: { 'Retry-After': '2' }, status: 429 })
      }
      const list = url.match(/^[^?]+\/r2\/buckets\/([^/]+)\/objects\?(.*)$/u)
      if (list) {
        const query = new URLSearchParams(list[2])
        const prefix = `${list[1]}/${query.get('prefix') ?? ''}`
        const keys = [...stored.keys()].filter(id => id.startsWith(prefix)).sort()
        const start = Number(query.get('cursor') ?? 0)
        const size = options.pageSize ?? Number(query.get('per_page'))
        const page = keys.slice(start, start + size)
        const more = start + size < keys.length
        return Response.json({
          result: page.map(id => {
            const object = stored.get(id)!
            return {
              etag: md5(object.body),
              http_metadata: { cacheControl: object.cacheControl, contentType: object.type },
              key: id.slice(list[1]!.length + 1),
              size: object.body.byteLength
            }
          }),
          result_info: { cursor: more ? String(start + size) : '', is_truncated: more },
          success: true
        })
      }
      const r2 = url.match(/\/r2\/buckets\/([^/]+)\/objects\/(.+)$/u)
      const id = `${r2?.[1]}/${r2?.[2]}`
      if (init?.method === 'PUT') {
        const body = new Uint8Array(init.body as Uint8Array)
        const headers = init.headers as Record<string, string>
        stored.set(id, {
          body,
          cacheControl: headers['Cache-Control'] ?? '',
          type: headers['Content-Type'] ?? ''
        })
        return Response.json({ result: { etag: md5(body), key: r2?.[2] }, success: true })
      }
      const object = stored.get(id)
      return object
        ? new Response(new Uint8Array(object.body))
        : new Response('missing', { status: 404 })
    }
    if (url.startsWith('https://cdn')) throw new Error(`read the CDN: ${url}`)
    const body = sources[url]
    if (body)
      return new Response(new Uint8Array(body), { headers: { 'Content-Type': 'image/png' } })
    throw new TypeError('fetch failed')
  })
  return Object.assign(fetcher, { stored })
}

/** The R2 calls a fake saw, as `METHOD bucket/key` (`LIST bucket` for the list API). */
function r2Calls(fetcher: ReturnType<typeof fakeFetch>): string[] {
  return fetcher.mock.calls.flatMap(([input, init]) => {
    const url = String(input)
    const match = url.match(/\/r2\/buckets\/([^/?]+)\/objects(?:\/(.+)|\?.*)$/u)
    if (!match) return []
    return [match[2] ? `${init?.method ?? 'GET'} ${match[1]}/${match[2]}` : `LIST ${match[1]}`]
  })
}

describe('media upload plans', () => {
  it('accepts only this site’s content-addressed keys with matching types', () => {
    expect(mediaPlanSchema.parse(plan).objects).toHaveLength(2)
    const refuse = (patch: Record<string, unknown>) =>
      mediaPlanSchema.safeParse({ ...plan, objects: [{ ...remote, ...patch }] }).success
    expect(refuse({ key: 'serp.co/index.html' })).toBe(false)
    expect(refuse({ key: remote.key.replace(/[0-9a-f]{16}\.png$/u, 'ffffffffffffffff.png') })).toBe(
      false
    )
    expect(refuse({ contentType: 'image/webp' })).toBe(false)
    expect(refuse({ source: 'http://assets.example/logo.png' })).toBe(false)
    expect(refuse({ bytes: 6 * 1024 * 1024 })).toBe(false)
    expect(
      mediaPlanSchema.safeParse({ ...plan, objects: [remote, remote] }).success,
      'duplicate key'
    ).toBe(false)
  })

  it('verifies bytes, digest, format, and dimensions', () => {
    expect(verifyObject(remote, png)).toBeNull()
    expect(verifyObject({ ...remote, width: 65 }, png)).toBe('dimensions_mismatch')
    expect(verifyObject({ ...remote, bytes: png.byteLength + 1 }, png)).toMatch(/^bytes/u)
    const changed = new Uint8Array(png)
    changed[changed.length - 1] = 0
    expect(verifyObject(remote, changed)).toBe('sha256_mismatch')
  })

  it('dry-runs locally: fetches and verifies every source, writes nothing', async () => {
    const fetcher = fakeFetch()
    expect(await upload({ dryRun: true, env: {}, fetcher, target: 'staging' })).toEqual({
      failed: [],
      id: 'media-upload-test',
      present: 0,
      target: 'staging',
      uploaded: 0,
      verified: 2
    })
    expect(fetcher.mock.calls.map(([url, init]) => [String(url), init?.method ?? 'GET'])).toEqual([
      [remote.source, 'GET']
    ])
  })

  it('uploads for real only from its protected workflow, branch, and confirmation', async () => {
    const fetcher = fakeFetch()
    for (const [overrides, message] of [
      [{ CI: undefined }, 'GitHub Actions'],
      [{ GITHUB_REF: 'refs/heads/main' }, 'reviewed staging'],
      [
        { GITHUB_WORKFLOW_REF: 'owner/repo/.github/workflows/upload-media.yml@refs/heads/staging' },
        'upload-media-staging.yml'
      ],
      [{ MEDIA_UPLOAD_CONFIRM: 'upload-media-best.serp.co-production' }, 'confirmation']
    ] as const) {
      await expect(
        upload({
          env: { ...workflowEnvironment, ...overrides },
          fetcher,
          target: 'staging'
        })
      ).rejects.toThrow(message)
    }
    await expect(
      upload({ env: workflowEnvironment, fetcher, target: 'production' })
    ).rejects.toThrow('upload-media.yml')
    await expect(
      uploadMediaPlan('d1/publications/x.json', { dryRun: true, fetcher, target: 'staging' })
    ).rejects.toThrow('d1/media')
    // Without a test's own directory, a plan outside d1/media (like this suite's) is refused.
    await expect(
      uploadMediaPlan(planPath, { dryRun: true, fetcher, target: 'staging' })
    ).rejects.toThrow('Media plans must be checked in directly under d1/media.')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('uploads what the bucket lacks, into the target bucket, with the immutable policy', async () => {
    const fetcher = fakeFetch({ [`cdn-staging/${repo.key}`]: tile })
    expect(
      await upload({
        env: workflowEnvironment,
        fetcher,
        r2: fast(),
        target: 'staging'
      })
    ).toMatchObject({ failed: [], present: 1, uploaded: 1 })
    const puts = fetcher.mock.calls.filter(([, init]) => init?.method === 'PUT')
    expect(puts.map(([url]) => String(url))).toEqual([
      `https://api.cloudflare.com/client/v4/accounts/account/r2/buckets/cdn-staging/objects/${remote.key}`
    ])
    expect(fetcher.stored.get(`cdn-staging/${remote.key}`)?.body).toEqual(png)
    // One list call found the present object; it was never read back.
    expect(r2Calls(fetcher)).toEqual(['LIST cdn-staging', `PUT cdn-staging/${remote.key}`])
    expect(puts[0]?.[1]?.headers).toEqual({
      Authorization: 'Bearer token',
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Content-Type': 'image/png'
    })
  })

  it('verifies an object already in the bucket and never overwrites a mismatch (#97 review B2)', async () => {
    // Right size, wrong bytes: the skip path checks the digest like an upload does.
    const impostor = new Uint8Array(png)
    impostor[impostor.length - 5] = 0
    const fetcher = fakeFetch({
      [`cdn-staging/${remote.key}`]: impostor,
      [`cdn-staging/${repo.key}`]: tile
    })
    const summary = await upload({
      env: workflowEnvironment,
      fetcher,
      r2: fast(),
      target: 'staging'
    })
    // Same size, other bytes: R2's ETag (the stored bytes' MD5) is not the plan's.
    expect(summary).toMatchObject({
      failed: [{ key: remote.key, reason: 'present_mismatch:md5_mismatch' }],
      present: 1,
      uploaded: 0
    })
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'PUT')).toEqual([])
    expect(fetcher.stored.get(`cdn-staging/${remote.key}`)?.body).toEqual(impostor)
    expect(r2Calls(fetcher)).toEqual(['LIST cdn-staging'])
    // The source is not even fetched for a key the bucket already holds.
    expect(fetcher.mock.calls.map(([url]) => String(url))).not.toContain(remote.source)
  })

  it('copies production objects from the staging bucket through the R2 API (#97 review S3)', async () => {
    const production = {
      ...workflowEnvironment,
      GITHUB_REF: 'refs/heads/main',
      GITHUB_WORKFLOW_REF: 'owner/repo/.github/workflows/upload-media.yml@refs/heads/main',
      MEDIA_UPLOAD_CONFIRM: 'upload-media-best.serp.co-production'
    }
    const fetcher = fakeFetch({ [`cdn-staging/${remote.key}`]: png })
    const summary = await upload({
      env: production,
      fetcher,
      r2: fast(),
      target: 'production'
    })
    expect(summary).toMatchObject({
      failed: [{ key: repo.key, reason: 'not_in_staging_bucket' }],
      uploaded: 1
    })
    expect(r2Calls(fetcher).sort()).toEqual(
      [
        'LIST cdn',
        `GET cdn-staging/${remote.key}`,
        `GET cdn-staging/${repo.key}`,
        `PUT cdn/${remote.key}`
      ].sort()
    )
    expect(fetcher.stored.get(`cdn/${remote.key}`)?.body).toEqual(png)
    // A tampered staging object fails closed with sha256_mismatch and no PUT.
    const tampered = new Uint8Array(png)
    tampered[tampered.length - 5] = 0
    const poisoned = fakeFetch({
      [`cdn-staging/${remote.key}`]: tampered,
      [`cdn-staging/${repo.key}`]: tile
    })
    expect(
      await upload({
        env: production,
        fetcher: poisoned,
        r2: fast(),
        target: 'production'
      })
    ).toMatchObject({ failed: [{ key: remote.key, reason: 'sha256_mismatch' }], uploaded: 1 })
    expect(poisoned.stored.has(`cdn/${remote.key}`)).toBe(false)
  })

  it('reports a source that changed or vanished instead of uploading it', async () => {
    const changedPlan = {
      ...plan,
      objects: [{ ...remote, height: 33 }, object(png, 'https://gone.example/a.png', 'g', 64, 32)]
    }
    writeFileSync(planPath, JSON.stringify(changedPlan))
    try {
      const summary = await upload({
        env: workflowEnvironment,
        fetcher: fakeFetch(),
        r2: fast(),
        target: 'staging'
      })
      expect(summary.uploaded).toBe(0)
      expect(summary.failed.map(failure => failure.reason).sort()).toEqual([
        'dimensions_mismatch',
        'site_unreachable'
      ])
    } finally {
      writeFileSync(planPath, JSON.stringify(plan))
    }
  })

  it('rides out 429s: waits Retry-After, retries, and still uploads everything (#95 release blocker 3)', async () => {
    const r2 = fast()
    const fetcher = fakeFetch({}, { [remote.source]: png }, { throttle: 5 })
    const summary = await upload({
      env: workflowEnvironment,
      fetcher,
      r2,
      target: 'staging'
    })
    expect(summary).toMatchObject({ failed: [], present: 0, uploaded: 2 })
    // Five 429s, each answered with `Retry-After: 2`.
    expect(r2.clock.slept.filter(ms => ms === 2000)).toHaveLength(5)
    expect(fetcher.stored.get(`cdn-staging/${remote.key}`)?.body).toEqual(png)
    expect(fetcher.stored.get(`cdn-staging/${repo.key}`)?.body).toEqual(tile)
  })

  it('reports a key it could not reach past persistent 429s, and a rerun finishes the rest', async () => {
    const fetcher = fakeFetch({}, { [remote.source]: png }, { throttle: 9 })
    // The list call and one object exhaust their attempts on 429s.
    await expect(
      upload({
        env: workflowEnvironment,
        fetcher,
        r2: fast(),
        target: 'staging'
      })
    ).rejects.toThrow('r2_list_429')
    const rerun = await upload({
      env: workflowEnvironment,
      fetcher,
      r2: fast(),
      target: 'staging'
    })
    expect(rerun).toMatchObject({ failed: [], uploaded: 2 })
    const again = await upload({
      env: workflowEnvironment,
      fetcher,
      r2: fast(),
      target: 'staging'
    })
    // A finished plan costs one list call: nothing is read back or written again.
    expect(again).toMatchObject({ failed: [], present: 2, uploaded: 0 })
    expect(r2Calls(fetcher).slice(-1)).toEqual(['LIST cdn-staging'])
  })

  it('lists every page of a bucket through the cursor', async () => {
    const fetcher = fakeFetch(
      { [`cdn-staging/${remote.key}`]: png, [`cdn-staging/${repo.key}`]: tile },
      undefined,
      { pageSize: 1 }
    )
    expect(
      await upload({
        env: workflowEnvironment,
        fetcher,
        r2: fast(),
        target: 'staging'
      })
    ).toMatchObject({ failed: [], present: 2, uploaded: 0 })
    expect(r2Calls(fetcher)).toEqual(['LIST cdn-staging', 'LIST cdn-staging'])
  })
})

describe('the R2 rate limiter', () => {
  it('spaces requests under the API limit after its burst', async () => {
    const clock = fakeClock()
    const limiter = new RateLimiter(900, 300_000, 10, clock)
    for (let index = 0; index < 910; index += 1) await limiter.acquire()
    // 10 at once, then one every 300_000 / 900 ms: 900 requests take 300 s, under 1,200 / 5 min.
    expect(clock.now()).toBeGreaterThanOrEqual(299_000)
    expect(clock.now()).toBeLessThanOrEqual(301_000)
  })

  it('serves concurrent callers in order from one budget', async () => {
    const clock = fakeClock()
    const limiter = new RateLimiter(60, 60_000, 1, clock)
    const order: number[] = []
    await Promise.all(
      [0, 1, 2, 3].map(async index => {
        await limiter.acquire()
        order.push(index)
      })
    )
    expect(order).toEqual([0, 1, 2, 3])
    expect(clock.now()).toBe(3000)
  })
})
