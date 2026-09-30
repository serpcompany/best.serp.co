import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { publishRemoteManifest } from './d1-remote-publisher.ts'

const manifestPath = resolve('d1/publications/remote-publisher-test.yaml')
const beforeChecksum = 'a'.repeat(64)
const source = `version: 1
id: remote-publisher-test
siteId: serp.software
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
  D1_PUBLICATION_CONFIRM: 'publish-serp.software-production',
  DEPLOY_SITE_ID: 'serp.software',
  CLOUDFLARE_ACCOUNT_ID: 'account',
  CLOUDFLARE_API_TOKEN: 'token',
  CLOUDFLARE_D1_PRODUCTION_DATABASE_ID: 'database'
}

mkdirSync(resolve('d1/publications'), { recursive: true })
writeFileSync(manifestPath, source)

afterAll(() => {
  try {
    require('node:fs').unlinkSync(manifestPath)
  } catch {}
})

function response(result: unknown): Response {
  return new Response(JSON.stringify({ success: true, result }), {
    headers: { 'Content-Type': 'application/json' },
    status: 200
  })
}

describe('remote D1 publisher', () => {
  it('preflights and publishes the reviewed manifest as one API batch', async () => {
    const fetchImplementation = vi
      .fn()
      .mockResolvedValueOnce(response([{ success: true, results: [] }]))
      .mockResolvedValueOnce(response([{ success: true, results: [] }]))
      .mockResolvedValueOnce(response([{ success: true, results: [] }]))
    const result = await publishRemoteManifest(manifestPath, environment, fetchImplementation)
    expect(result.idempotent).toBe(false)
    expect(fetchImplementation).toHaveBeenCalledTimes(3)
    const publishBody = JSON.parse(fetchImplementation.mock.calls[2]?.[1]?.body as string) as {
      batch: unknown[]
    }
    expect(publishBody.batch.length).toBeGreaterThan(1)
  })

  it('returns idempotent success only for the same manifest content', async () => {
    const initialFetch = vi
      .fn()
      .mockResolvedValueOnce(response([{ success: true, results: [] }]))
      .mockResolvedValueOnce(response([{ success: true, results: [] }]))
      .mockResolvedValueOnce(response([{ success: true, results: [] }]))
    const initial = await publishRemoteManifest(manifestPath, environment, initialFetch)
    const inputChecksum = JSON.parse(initialFetch.mock.calls[2]?.[1]?.body as string).batch[4]
      .params[4]
    const retryFetch = vi
      .fn()
      .mockResolvedValueOnce(response([{ success: true, results: [] }]))
      .mockResolvedValueOnce(
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
    expect(retryFetch).toHaveBeenCalledTimes(2)
  })

  it('records a failed outcome after a rolled-back batch', async () => {
    const fetchImplementation = vi
      .fn()
      .mockResolvedValueOnce(response([{ success: true, results: [] }]))
      .mockResolvedValueOnce(response([{ success: true, results: [] }]))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: false, errors: [{ message: 'stale version' }] }), {
          status: 409
        })
      )
      .mockResolvedValueOnce(response([{ success: true, results: [] }]))
      .mockResolvedValueOnce(response([{ success: true, results: [] }]))
    await expect(
      publishRemoteManifest(manifestPath, environment, fetchImplementation)
    ).rejects.toThrow('stale version')
    expect(fetchImplementation).toHaveBeenCalledTimes(5)
    const failureBody = JSON.parse(fetchImplementation.mock.calls[4]?.[1]?.body as string) as {
      batch: Array<{ sql: string }>
    }
    expect(failureBody.batch[0]?.sql).toContain('cutover_unlocked')
    expect(failureBody.batch[1]?.sql).toContain("outcome='failed'")
  })

  it('does not inspect publication history or write an audit row while cutover is locked', async () => {
    const fetchImplementation = vi.fn().mockResolvedValueOnce(
      response([
        {
          success: true,
          results: [{ id: 'd1-cutover-lock-v1:serp.software:run-1' }]
        }
      ])
    )
    await expect(
      publishRemoteManifest(manifestPath, environment, fetchImplementation)
    ).rejects.toMatchObject({ code: 'cutover_frozen', status: 503 })
    expect(fetchImplementation).toHaveBeenCalledTimes(1)
  })
})
