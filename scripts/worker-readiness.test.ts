import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import {
  SMOKE_TEST_HEADER,
  WORKER_VERSION_HEADER
} from '../apps/web/src/lib/environment/site-environment'
import type { GateClock } from './d1-preview-http-gates'
import { project } from './project'
import { smokeReadinessConfirmations, workerReadiness } from './worker-readiness'

const deployed = '0a1b2c3d-0000-4000-8000-00000000d0d0'
const previous = '0a1b2c3d-0000-4000-8000-0000000000aa'
const origin = project.remote.staging.reviewOrigin
const fixtures = mkdtempSync(join(tmpdir(), 'worker-readiness-'))

afterEach(() => vi.unstubAllGlobals())
afterAll(() => rmSync(fixtures, { force: true, recursive: true }))

function virtualClock(): GateClock {
  let now = 0
  return {
    now: () => now,
    sleep: async milliseconds => {
      now += milliseconds
    }
  }
}

/** The Worker answers each probe with the next version in `versions`, then the last one. */
function stubWorker(versions: string[]): URL[] {
  const probes: URL[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      probes.push(new URL(String(input)))
      expect(new Headers(init?.headers).get(SMOKE_TEST_HEADER)).toBe('1')
      const version = versions[Math.min(probes.length, versions.length) - 1] as string
      return new Response('User-agent: *\n', { headers: { [WORKER_VERSION_HEADER]: version } })
    })
  )
  return probes
}

describe('worker readiness before the staging smoke (#417)', () => {
  it('waits for five ready answers in a row from the version the deploy recorded', async () => {
    const output = join(fixtures, 'wrangler-output.ndjson')
    writeFileSync(output, `${JSON.stringify({ type: 'deploy', version_id: deployed })}\n`)
    const probes = stubWorker([previous, deployed, previous, deployed])
    const lines: string[] = []
    await expect(
      workerReadiness(
        origin,
        { WRANGLER_OUTPUT_FILE_PATH: output },
        { clock: virtualClock(), log: line => lines.push(line) }
      )
    ).resolves.toBeUndefined()
    expect(smokeReadinessConfirmations).toBe(5)
    // An answer from the previous version resets the run: two misses, then five in a row.
    expect(probes.map(probe => probe.href)).toEqual(Array(8).fill(`${origin}/robots.txt`))
    expect(lines.at(-1)).toMatch(
      new RegExp(`^Worker version ${deployed} is ready on ${origin}: 5 answers in a row under`)
    )
  })

  it('refuses to wait without the deployed version or on anything but a clean HTTPS origin', async () => {
    const probes = stubWorker([deployed])
    await expect(workerReadiness(origin, {})).rejects.toThrow('needs the deployed version')
    await expect(workerReadiness(undefined, {})).rejects.toThrow('Usage: worker-readiness.ts')
    for (const value of ['not a url', 'http://example.com', `${origin}/robots.txt`, `${origin}?a`])
      await expect(
        workerReadiness(value, { EXPECTED_WORKER_VERSION: deployed }),
        value
      ).rejects.toThrow('HTTPS origin')
    expect(probes).toEqual([])
  })
})
