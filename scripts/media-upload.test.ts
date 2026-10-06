import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { solidPng } from './fixtures/solid-png'
import { mediaPlanSchema, uploadMediaPlan, verifyObject } from './media-upload'

const planPath = resolve('d1/media/media-upload-test.json')
const fallbackTile = 'apps/web/public/listing-logos/favicon-fallback-512x512.png'
const png = solidPng(64, 32, [1, 2, 3])
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const tile = new Uint8Array(readFileSync(resolve(fallbackTile)))

function object(bytes: Uint8Array, source: string, slug: string, width: number, height: number) {
  const sha256 = sha(bytes)
  return {
    bytes: bytes.byteLength,
    contentType: 'image/png',
    height,
    key: `best.serp.co/listings/${slug}/logo/${sha256.slice(0, 16)}.png`,
    sha256,
    source,
    width
  }
}

const remote = object(png, 'https://assets.example/logo.png', 'remote.example', 64, 32)
const repo = object(tile, `repo:${fallbackTile}`, 'repo.example', 512, 512)
const plan = { id: 'media-upload-test', objects: [remote, repo], site: 'best.serp.co', version: 1 }

mkdirSync(resolve('d1/media'), { recursive: true })
writeFileSync(planPath, JSON.stringify(plan))
afterAll(() => rmSync(planPath, { force: true }))

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

/**
 * Sources answer with their bytes; each R2 bucket (`bucket/key` → bytes) answers GETs through the
 * API and stores PUTs. Nothing is read from a media host's CDN.
 */
function fakeFetch(
  buckets: Record<string, Uint8Array> = {},
  sources: Record<string, Uint8Array> = { [remote.source]: png }
) {
  const stored = new Map(Object.entries(buckets))
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const r2 = url.match(
      /^https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/account\/r2\/buckets\/([^/]+)\/objects\/(.+)$/u
    )
    if (r2) {
      const id = `${r2[1]}/${r2[2]}`
      if (init?.method === 'PUT') {
        stored.set(id, new Uint8Array(init.body as Uint8Array))
        return new Response('{}', { status: 200 })
      }
      const body = stored.get(id)
      return body ? new Response(new Uint8Array(body)) : new Response('missing', { status: 404 })
    }
    if (url.startsWith('https://cdn')) throw new Error(`read the CDN: ${url}`)
    const body = sources[url]
    if (body)
      return new Response(new Uint8Array(body), { headers: { 'Content-Type': 'image/png' } })
    throw new TypeError('fetch failed')
  })
  return Object.assign(fetcher, { stored })
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
    expect(
      await uploadMediaPlan(planPath, { dryRun: true, env: {}, fetcher, target: 'staging' })
    ).toEqual({
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
        uploadMediaPlan(planPath, {
          env: { ...workflowEnvironment, ...overrides },
          fetcher,
          target: 'staging'
        })
      ).rejects.toThrow(message)
    }
    await expect(
      uploadMediaPlan(planPath, { env: workflowEnvironment, fetcher, target: 'production' })
    ).rejects.toThrow('upload-media.yml')
    await expect(
      uploadMediaPlan('d1/publications/x.json', { dryRun: true, fetcher, target: 'staging' })
    ).rejects.toThrow('d1/media')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('uploads what the bucket lacks, into the target bucket, with the immutable policy', async () => {
    const fetcher = fakeFetch({ [`cdn-staging/${repo.key}`]: tile })
    expect(
      await uploadMediaPlan(planPath, { env: workflowEnvironment, fetcher, target: 'staging' })
    ).toMatchObject({ failed: [], present: 1, uploaded: 1 })
    const puts = fetcher.mock.calls.filter(([, init]) => init?.method === 'PUT')
    expect(puts.map(([url]) => String(url))).toEqual([
      `https://api.cloudflare.com/client/v4/accounts/account/r2/buckets/cdn-staging/objects/${remote.key}`
    ])
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
    const summary = await uploadMediaPlan(planPath, {
      env: workflowEnvironment,
      fetcher,
      target: 'staging'
    })
    expect(summary).toMatchObject({
      failed: [{ key: remote.key, reason: 'present_mismatch:sha256_mismatch' }],
      present: 1,
      uploaded: 0
    })
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'PUT')).toEqual([])
    expect(fetcher.stored.get(`cdn-staging/${remote.key}`)).toEqual(impostor)
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
    const summary = await uploadMediaPlan(planPath, {
      env: production,
      fetcher,
      target: 'production'
    })
    expect(summary).toMatchObject({
      failed: [{ key: repo.key, reason: 'not_in_staging_bucket' }],
      uploaded: 1
    })
    const gets = fetcher.mock.calls
      .filter(([, init]) => (init?.method ?? 'GET') === 'GET')
      .map(([url]) =>
        String(url)
          .replace('https://api.cloudflare.com/client/v4/accounts/account/r2/buckets/', '')
          .replace('/objects/', '/')
      )
      .sort()
    expect(gets).toEqual(
      [
        `cdn/${remote.key}`,
        `cdn/${repo.key}`,
        `cdn-staging/${remote.key}`,
        `cdn-staging/${repo.key}`
      ].sort()
    )
    expect(fetcher.stored.get(`cdn/${remote.key}`)).toEqual(png)
    // A tampered staging object fails closed with sha256_mismatch and no PUT.
    const tampered = new Uint8Array(png)
    tampered[tampered.length - 5] = 0
    const poisoned = fakeFetch({
      [`cdn-staging/${remote.key}`]: tampered,
      [`cdn-staging/${repo.key}`]: tile
    })
    expect(
      await uploadMediaPlan(planPath, { env: production, fetcher: poisoned, target: 'production' })
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
      const summary = await uploadMediaPlan(planPath, {
        env: workflowEnvironment,
        fetcher: fakeFetch(),
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
})
