import { createHash } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { publishRemoteManifest, verifyTargetDatabase } from './d1-remote-publisher.ts'
import { solidPng } from './fixtures/solid-png'
import { project } from './project'

const manifestPath = resolve('d1/publications/remote-publisher-test.yaml')
const mediaPath = resolve('d1/publications/remote-publisher-media-test.yaml')
const beforeChecksum = 'a'.repeat(64)
const source = `version: 1
id: remote-publisher-test
basePublicationVersion: 1
provenance:
  actor: publisher@example.com
  workflow: github/publish-d1
  beforeChecksum: ${beforeChecksum}
operations:
  - action: category-create
    category:
      slug: testing
      name: Testing
      description: Test category
      order: 1
`
const png = solidPng(4, 4, [9, 9, 9])
const pngSha = createHash('sha256').update(png).digest('hex')
const mediaKey = `best.serp.co/listings/testing/logo/${pngSha.slice(0, 16)}.png`
const expectedRows = [{ kind: 'logo', url: 'https://dead.example/logo.png', key: null }]
const mediaSource = `version: 1
id: remote-publisher-media-test
concurrency: rows
provenance:
  actor: publisher@example.com
  workflow: github/legacy-media
operations:
  - action: listing-media-update
    id: lst_remote_media_test
    slug: testing
    expected:
      - kind: logo
        url: https://dead.example/logo.png
    media:
      logo:
        bytes: ${png.byteLength}
        contentType: image/png
        height: 4
        key: ${mediaKey}
        sha256: ${pngSha}
        source: https://testing.example/icon.png
        width: 4
`
const production = {
  CI: 'true',
  GITHUB_ACTIONS: 'true',
  GITHUB_REF: 'refs/heads/main',
  GITHUB_SHA: 'a'.repeat(40),
  GITHUB_WORKFLOW_REF: 'owner/repo/.github/workflows/publish-d1.yml@refs/heads/main',
  D1_PUBLICATION_CONFIRM: 'publish-best.serp.co-production',
  CLOUDFLARE_ACCOUNT_ID: 'account',
  CLOUDFLARE_API_TOKEN: 'token',
  CLOUDFLARE_D1_DATABASE_ID: project.remote.production.databaseId
}
const staging = {
  ...production,
  CLOUDFLARE_D1_DATABASE_ID: project.remote.staging.databaseId,
  D1_PUBLICATION_CONFIRM: 'publish-best.serp.co-staging',
  GITHUB_REF: 'refs/heads/staging',
  GITHUB_WORKFLOW_REF: 'owner/repo/.github/workflows/publish-d1-staging.yml@refs/heads/staging'
}

mkdirSync(resolve('d1/publications'), { recursive: true })
writeFileSync(manifestPath, source)
writeFileSync(mediaPath, mediaSource)
afterAll(() => {
  rmSync(manifestPath, { force: true })
  rmSync(mediaPath, { force: true })
})

function json(result: unknown, status = 200, success = true): Response {
  return new Response(JSON.stringify({ success, result }), {
    headers: { 'Content-Type': 'application/json' },
    status
  })
}

interface Batch {
  params: unknown[]
  sql: string
}

/**
 * A Cloudflare API fake: D1 database lookups name each project database, the R2 buckets hold
 * `objects`, and `query` answers every D1 batch (the default: one empty result per statement).
 */
function cloudflare(
  options: {
    names?: Record<string, string>
    objects?: Record<string, Uint8Array>
    query?: (batch: Batch[]) => Response
  } = {}
) {
  const names = options.names ?? {
    [project.remote.production.databaseId]: project.remote.production.databaseName,
    [project.remote.staging.databaseId]: project.remote.staging.databaseName
  }
  const batches: Batch[][] = []
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const r2 = url.match(/\/r2\/buckets\/([^/]+)\/objects\/(.+)$/u)
    if (r2) {
      const body = options.objects?.[`${r2[1]}/${r2[2]}`]
      return body ? new Response(new Uint8Array(body)) : new Response('missing', { status: 404 })
    }
    const lookup = url.match(/\/d1\/database\/([^/]+)$/u)
    if (lookup) {
      const name = names[lookup[1] ?? '']
      return name ? json({ name, uuid: lookup[1] }) : json(null, 404, false)
    }
    const batch = (JSON.parse(String(init?.body)) as { batch: Batch[] }).batch
    batches.push(batch)
    return (
      options.query?.(batch) ?? json(batch.map(() => ({ success: true, results: [] as unknown[] })))
    )
  })
  return { batches, fetcher }
}

describe('remote D1 publisher', () => {
  it('requires the protected workflow, reviewed main, and exact confirmation', async () => {
    const fetchImplementation = vi.fn()
    await expect(
      publishRemoteManifest(
        manifestPath,
        { ...production, D1_PUBLICATION_CONFIRM: 'publish-serp.software-production' },
        fetchImplementation
      )
    ).rejects.toThrow('publish-best.serp.co-production')
    await expect(
      publishRemoteManifest(
        manifestPath,
        { ...production, GITHUB_WORKFLOW_REF: 'owner/repo/.github/workflows/other.yml@main' },
        fetchImplementation
      )
    ).rejects.toThrow('publish-d1.yml')
    await expect(
      publishRemoteManifest(
        manifestPath,
        { ...production, GITHUB_REF: 'refs/heads/feature' },
        fetchImplementation
      )
    ).rejects.toThrow('reviewed main')
    expect(fetchImplementation).not.toHaveBeenCalled()
  })

  it('publishes to staging only from staging, through its own workflow and confirmation (#95)', async () => {
    const refused = vi.fn()
    for (const [overrides, message] of [
      [
        { D1_PUBLICATION_CONFIRM: 'publish-best.serp.co-production' },
        'publish-best.serp.co-staging'
      ],
      [{ GITHUB_REF: 'refs/heads/main' }, 'reviewed staging'],
      [
        { GITHUB_WORKFLOW_REF: 'owner/repo/.github/workflows/publish-d1.yml@refs/heads/staging' },
        'publish-d1-staging.yml'
      ]
    ] as const) {
      await expect(
        publishRemoteManifest(manifestPath, { ...staging, ...overrides }, refused, 'staging')
      ).rejects.toThrow(message)
    }
    await expect(publishRemoteManifest(manifestPath, staging, refused)).rejects.toThrow(
      'publish-d1.yml'
    )
    await expect(
      publishRemoteManifest(manifestPath, production, refused, 'staging')
    ).rejects.toThrow('publish-d1-staging.yml')
    expect(refused).not.toHaveBeenCalled()
    const { fetcher } = cloudflare()
    await expect(
      publishRemoteManifest(manifestPath, staging, fetcher, 'staging')
    ).resolves.toMatchObject({ idempotent: false })
    expect(String(fetcher.mock.calls.at(-1)?.[0])).toBe(
      `https://api.cloudflare.com/client/v4/accounts/account/d1/database/${project.remote.staging.databaseId}/query`
    )
  })

  it('writes only to the target’s own database, as Cloudflare names it (#97 review B4)', async () => {
    // Each target refuses the other's database ID before any request.
    const swapped = vi.fn()
    await expect(
      publishRemoteManifest(
        manifestPath,
        { ...staging, CLOUDFLARE_D1_DATABASE_ID: project.remote.production.databaseId },
        swapped,
        'staging'
      )
    ).rejects.toThrow('not the staging database best-serp-co-staging')
    await expect(
      publishRemoteManifest(
        manifestPath,
        { ...production, CLOUDFLARE_D1_DATABASE_ID: project.remote.staging.databaseId },
        swapped
      )
    ).rejects.toThrow('not the production database best-serp-co-production')
    expect(swapped).not.toHaveBeenCalled()
    const { CLOUDFLARE_D1_DATABASE_ID: _id, ...withoutDatabase } = production
    await expect(publishRemoteManifest(manifestPath, withoutDatabase, swapped)).rejects.toThrow(
      'CLOUDFLARE_D1_DATABASE_ID'
    )
    // Cloudflare must name the database as the target's, and is asked before any write.
    const renamed = cloudflare({
      names: { [project.remote.production.databaseId]: project.remote.staging.databaseName }
    })
    await expect(publishRemoteManifest(manifestPath, production, renamed.fetcher)).rejects.toThrow(
      'not best-serp-co-production'
    )
    expect(renamed.batches).toEqual([])
    // wrangler.jsonc must still match the reviewed identity.
    const drifted = resolve('d1/publications/remote-publisher-wrangler.jsonc')
    writeFileSync(drifted, JSON.stringify({ env: { production: { name: 'other' } } }))
    try {
      await expect(
        verifyTargetDatabase(production, 'production', cloudflare().fetcher, drifted)
      ).rejects.toThrow('does not match the reviewed production identity')
    } finally {
      rmSync(drifted, { force: true })
    }
  })

  it('preflights and publishes the reviewed manifest as one API batch', async () => {
    const { batches, fetcher } = cloudflare()
    const result = await publishRemoteManifest(manifestPath, production, fetcher)
    expect(result.idempotent).toBe(false)
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      `https://api.cloudflare.com/client/v4/accounts/account/d1/database/${project.remote.production.databaseId}`,
      `https://api.cloudflare.com/client/v4/accounts/account/d1/database/${project.remote.production.databaseId}/query`,
      `https://api.cloudflare.com/client/v4/accounts/account/d1/database/${project.remote.production.databaseId}/query`
    ])
    expect(batches[1]?.length).toBeGreaterThan(1)
    expect(batches[1]?.map(item => item.sql).join('\n')).not.toMatch(/site_id|sites\b/u)
  })

  it('returns idempotent success only for the same manifest content', async () => {
    const initial = cloudflare()
    const first = await publishRemoteManifest(manifestPath, production, initial.fetcher)
    const runInsert = initial.batches[1]?.find(item =>
      item.sql.startsWith('INSERT INTO publication_runs')
    )
    const inputChecksum = runInsert?.params[3]
    expect(inputChecksum).toMatch(/^[a-f0-9]{64}$/u)
    const succeeded = (input: unknown) =>
      cloudflare({
        query: () =>
          json([
            {
              success: true,
              results: [
                { after_checksum: first.afterChecksum, input_checksum: input, outcome: 'succeeded' }
              ]
            }
          ])
      })
    const retry = succeeded(inputChecksum)
    await expect(publishRemoteManifest(manifestPath, production, retry.fetcher)).resolves.toEqual({
      afterChecksum: first.afterChecksum,
      idempotent: true
    })
    expect(retry.batches).toHaveLength(1)
    await expect(
      publishRemoteManifest(manifestPath, production, succeeded('b'.repeat(64)).fetcher)
    ).rejects.toThrow('already used by different content')
  })

  it('records a failed outcome after a rolled-back batch', async () => {
    const { batches, fetcher } = cloudflare({
      query: batch =>
        batch.length > 1
          ? new Response(
              JSON.stringify({ success: false, errors: [{ message: 'stale version' }] }),
              {
                status: 409
              }
            )
          : json(batch.map(() => ({ success: true, results: [] })))
    })
    await expect(publishRemoteManifest(manifestPath, production, fetcher)).rejects.toThrow(
      'stale version'
    )
    const failure = batches.at(-1)
    expect(failure).toHaveLength(1)
    expect(failure?.[0]?.sql).toContain("outcome='failed'")
    expect(failure?.[0]?.sql).toContain('ON CONFLICT(manifest_id)')
    expect(failure?.[0]?.params).toContain('stale version')
  })
})

describe('row-level media manifests (#97 review B3)', () => {
  const stateRow = { checksum: 'c'.repeat(64), version: 41 }
  const currentMedia = JSON.stringify(expectedRows.map(row => [row.kind, row.url, row.key]))

  /** D1 with one listing whose rows match (or `media`), at publication version 41. */
  function d1(media = currentMedia, slug = 'testing') {
    return (batch: Batch[]) => {
      const [first] = batch
      if (batch.length > 1) return json(batch.map(() => ({ success: true, results: [] })))
      if (first?.sql.startsWith('SELECT version,checksum FROM publication_state')) {
        return json([{ success: true, results: [stateRow] }])
      }
      if (first?.sql.startsWith('SELECT l.id,l.slug')) {
        return json([{ success: true, results: [{ id: 'lst_remote_media_test', media, slug }] }])
      }
      return json([{ success: true, results: [] }])
    }
  }
  const objects = (bucket: string, body: Uint8Array = png) => ({ [`${bucket}/${mediaKey}`]: body })

  it('publishes on any environment whose rows match, at the version it reads', async () => {
    for (const [env, target] of [
      [staging, 'staging'],
      [production, 'production']
    ] as const) {
      const { batches, fetcher } = cloudflare({
        objects: objects(project.remote[target].media.bucket),
        query: d1()
      })
      await expect(publishRemoteManifest(mediaPath, env, fetcher, target)).resolves.toMatchObject({
        idempotent: false
      })
      const publish = batches.at(-1) ?? []
      const guard = publish.find(item => item.sql.includes('FROM publication_state WHERE id=1'))
      expect(guard?.params).toEqual([41, stateRow.checksum])
      const advance = publish.find(item => item.sql.startsWith('UPDATE publication_state'))
      expect(advance?.params.slice(0, 2)).toEqual([42, 'remote-publisher-media-test'])
      const rowGuard = publish.find(item => item.sql.includes('json_group_array'))
      expect(rowGuard?.params.at(-1)).toBe(currentMedia)
    }
  })

  it('reports drift and writes nothing when a listing changed since generation', async () => {
    const changed = JSON.stringify([['logo', 'https://new.example/logo.png', null]])
    for (const query of [d1(changed), d1(currentMedia, 'renamed')]) {
      const { batches, fetcher } = cloudflare({ objects: objects('cdn'), query })
      await expect(publishRemoteManifest(mediaPath, production, fetcher)).rejects.toThrow(
        /1 listings changed since this manifest was generated \(first: testing.*Nothing was written/u
      )
      expect(batches.every(batch => batch.length === 1)).toBe(true)
    }
  })

  it('refuses until the target’s own bucket holds every object as reviewed (#97 S4)', async () => {
    // Staging's bucket holding the object does not let production publish, and the reverse.
    const onStaging = cloudflare({ objects: objects('cdn-staging'), query: d1() })
    await expect(publishRemoteManifest(mediaPath, production, onStaging.fetcher)).rejects.toThrow(
      `1 hosted media objects are not in the cdn bucket as reviewed (first: ${mediaKey} (missing))`
    )
    const onProduction = cloudflare({ objects: objects('cdn'), query: d1() })
    await expect(
      publishRemoteManifest(mediaPath, staging, onProduction.fetcher, 'staging')
    ).rejects.toThrow('not in the cdn-staging bucket')
    // An object of the right size but other bytes is refused too.
    const tampered = new Uint8Array(png)
    tampered[tampered.length - 5] = 0
    const wrong = cloudflare({ objects: objects('cdn', tampered), query: d1() })
    await expect(publishRemoteManifest(mediaPath, production, wrong.fetcher)).rejects.toThrow(
      'sha256_mismatch'
    )
    for (const fake of [onStaging, onProduction, wrong]) {
      expect(fake.batches.every(batch => batch.length === 1)).toBe(true)
    }
  })

  it('is idempotent by its input, whatever version each environment published it at', async () => {
    const inputChecksum = createHash('sha256').update(mediaSource).digest('hex')
    const { fetcher } = cloudflare({
      query: () =>
        json([
          {
            success: true,
            results: [
              {
                after_checksum: 'd'.repeat(64),
                input_checksum: inputChecksum,
                outcome: 'succeeded'
              }
            ]
          }
        ])
    })
    await expect(publishRemoteManifest(mediaPath, production, fetcher)).resolves.toEqual({
      afterChecksum: 'd'.repeat(64),
      idempotent: true
    })
  })

  it('retries at the new version when another write moved it, and rechecks the rows', async () => {
    let state = stateRow
    let publishes = 0
    const { batches, fetcher } = cloudflare({
      objects: objects('cdn'),
      query: batch => {
        if (batch.length > 1) {
          publishes += 1
          if (publishes === 1) {
            // A concurrent admin edit advanced the version between the read and the batch.
            state = { checksum: 'e'.repeat(64), version: 42 }
            return new Response(
              JSON.stringify({ success: false, errors: [{ message: 'stale' }] }),
              {
                status: 409
              }
            )
          }
          return json(batch.map(() => ({ success: true, results: [] })))
        }
        const [first] = batch
        if (first?.sql.startsWith('SELECT version,checksum')) {
          return json([{ success: true, results: [state] }])
        }
        return d1()(batch)
      }
    })
    await expect(publishRemoteManifest(mediaPath, production, fetcher)).resolves.toMatchObject({
      idempotent: false
    })
    const final = batches.at(-1) ?? []
    expect(
      final.find(item => item.sql.includes('FROM publication_state WHERE id=1'))?.params
    ).toEqual([42, 'e'.repeat(64)])
    // The rows were checked before each attempt.
    expect(batches.filter(batch => batch[0]?.sql.startsWith('SELECT l.id,l.slug'))).toHaveLength(2)
  })
})
