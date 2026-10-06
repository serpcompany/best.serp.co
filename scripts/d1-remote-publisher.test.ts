import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { publishRemoteManifest } from './d1-remote-publisher.ts'

const manifestPath = resolve('d1/publications/remote-publisher-test.yaml')
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
const environment = {
  CI: 'true',
  GITHUB_ACTIONS: 'true',
  GITHUB_REF: 'refs/heads/main',
  GITHUB_SHA: 'a'.repeat(40),
  GITHUB_WORKFLOW_REF: 'owner/repo/.github/workflows/publish-d1.yml@refs/heads/main',
  D1_PUBLICATION_CONFIRM: 'publish-best.serp.co-production',
  CLOUDFLARE_ACCOUNT_ID: 'account',
  CLOUDFLARE_API_TOKEN: 'token',
  CLOUDFLARE_D1_DATABASE_ID: 'database'
}

const publicationsDirectory = resolve('d1/publications')
mkdirSync(publicationsDirectory, { recursive: true })
writeFileSync(manifestPath, source)

afterAll(() => {
  rmSync(manifestPath, { force: true })
})

function response(result: unknown): Response {
  return new Response(JSON.stringify({ success: true, result }), {
    headers: { 'Content-Type': 'application/json' },
    status: 200
  })
}

describe('remote D1 publisher', () => {
  it('requires the protected workflow, reviewed main, and exact confirmation', async () => {
    const fetchImplementation = vi.fn()
    await expect(
      publishRemoteManifest(
        manifestPath,
        { ...environment, D1_PUBLICATION_CONFIRM: 'publish-serp.software-production' },
        fetchImplementation
      )
    ).rejects.toThrow('publish-best.serp.co-production')
    await expect(
      publishRemoteManifest(
        manifestPath,
        { ...environment, GITHUB_WORKFLOW_REF: 'owner/repo/.github/workflows/other.yml@main' },
        fetchImplementation
      )
    ).rejects.toThrow('publish-d1.yml')
    await expect(
      publishRemoteManifest(
        manifestPath,
        { ...environment, GITHUB_REF: 'refs/heads/feature' },
        fetchImplementation
      )
    ).rejects.toThrow('reviewed main')
    expect(fetchImplementation).not.toHaveBeenCalled()
  })

  it('publishes to staging only from staging, through its own workflow and confirmation (#95)', async () => {
    const staging = {
      ...environment,
      D1_PUBLICATION_CONFIRM: 'publish-best.serp.co-staging',
      GITHUB_REF: 'refs/heads/staging',
      GITHUB_WORKFLOW_REF: 'owner/repo/.github/workflows/publish-d1-staging.yml@refs/heads/staging'
    }
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
    // A staging run can never publish to production, and the other way round.
    await expect(publishRemoteManifest(manifestPath, staging, refused)).rejects.toThrow(
      'publish-d1.yml'
    )
    await expect(
      publishRemoteManifest(manifestPath, environment, refused, 'staging')
    ).rejects.toThrow('publish-d1-staging.yml')
    expect(refused).not.toHaveBeenCalled()
    const fetchImplementation = vi
      .fn()
      .mockResolvedValueOnce(response([{ success: true, results: [] }]))
      .mockResolvedValueOnce(response([{ success: true, results: [] }]))
    await expect(
      publishRemoteManifest(manifestPath, staging, fetchImplementation, 'staging')
    ).resolves.toMatchObject({ idempotent: false })
    expect(fetchImplementation).toHaveBeenCalledTimes(2)
  })

  it('requires the explicit D1 database identity', async () => {
    const { CLOUDFLARE_D1_DATABASE_ID: _databaseId, ...withoutDatabase } = environment
    await expect(publishRemoteManifest(manifestPath, withoutDatabase, vi.fn())).rejects.toThrow(
      'CLOUDFLARE_D1_DATABASE_ID'
    )
  })

  it('preflights and publishes the reviewed manifest as one API batch', async () => {
    const fetchImplementation = vi
      .fn()
      .mockResolvedValueOnce(response([{ success: true, results: [] }]))
      .mockResolvedValueOnce(response([{ success: true, results: [] }]))
    const result = await publishRemoteManifest(manifestPath, environment, fetchImplementation)
    expect(result.idempotent).toBe(false)
    expect(fetchImplementation).toHaveBeenCalledTimes(2)
    expect(fetchImplementation.mock.calls[0]?.[0]).toBe(
      'https://api.cloudflare.com/client/v4/accounts/account/d1/database/database/query'
    )
    const publishBody = JSON.parse(fetchImplementation.mock.calls[1]?.[1]?.body as string) as {
      batch: Array<{ sql: string }>
    }
    expect(publishBody.batch.length).toBeGreaterThan(1)
    expect(publishBody.batch.map(item => item.sql).join('\n')).not.toMatch(/site_id|sites\b/u)
  })

  it('returns idempotent success only for the same manifest content', async () => {
    const initialFetch = vi
      .fn()
      .mockResolvedValueOnce(response([{ success: true, results: [] }]))
      .mockResolvedValueOnce(response([{ success: true, results: [] }]))
    const initial = await publishRemoteManifest(manifestPath, environment, initialFetch)
    const publishBatch = JSON.parse(initialFetch.mock.calls[1]?.[1]?.body as string)
      .batch as Array<{
      params: unknown[]
      sql: string
    }>
    const runInsert = publishBatch.find(item => item.sql.startsWith('INSERT INTO publication_runs'))
    const inputChecksum = runInsert?.params[3]
    expect(inputChecksum).toMatch(/^[a-f0-9]{64}$/u)
    const retryFetch = vi.fn().mockResolvedValueOnce(
      response([
        {
          success: true,
          results: [
            {
              outcome: 'succeeded',
              input_checksum: inputChecksum,
              after_checksum: initial.afterChecksum
            }
          ]
        }
      ])
    )
    await expect(publishRemoteManifest(manifestPath, environment, retryFetch)).resolves.toEqual({
      afterChecksum: initial.afterChecksum,
      idempotent: true
    })
    expect(retryFetch).toHaveBeenCalledTimes(1)

    const reusedFetch = vi.fn().mockResolvedValueOnce(
      response([
        {
          success: true,
          results: [
            {
              outcome: 'succeeded',
              input_checksum: 'b'.repeat(64),
              after_checksum: initial.afterChecksum
            }
          ]
        }
      ])
    )
    await expect(publishRemoteManifest(manifestPath, environment, reusedFetch)).rejects.toThrow(
      'already used by different content'
    )
  })

  it('records a failed outcome after a rolled-back batch', async () => {
    const fetchImplementation = vi
      .fn()
      .mockResolvedValueOnce(response([{ success: true, results: [] }]))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: false, errors: [{ message: 'stale version' }] }), {
          status: 409
        })
      )
      .mockResolvedValueOnce(response([{ success: true, results: [] }]))
    await expect(
      publishRemoteManifest(manifestPath, environment, fetchImplementation)
    ).rejects.toThrow('stale version')
    expect(fetchImplementation).toHaveBeenCalledTimes(3)
    const failureBody = JSON.parse(fetchImplementation.mock.calls[2]?.[1]?.body as string) as {
      batch: Array<{ params: unknown[]; sql: string }>
    }
    expect(failureBody.batch).toHaveLength(1)
    expect(failureBody.batch[0]?.sql).toContain("outcome='failed'")
    expect(failureBody.batch[0]?.sql).toContain('ON CONFLICT(manifest_id)')
    expect(failureBody.batch[0]?.params).toContain('stale version')
  })
})
