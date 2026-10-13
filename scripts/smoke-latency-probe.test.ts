import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const probe = resolve('scripts/smoke-latency-probe.sh')
const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function directory(): string {
  const created = mkdtempSync(join(tmpdir(), 'smoke-latency-probe-'))
  cleanups.push(() => rmSync(created, { force: true, recursive: true }))
  return created
}

/** Cloudflare's trace answers at ORD; the Worker answers 503 without the smoke-test header. */
async function fakeOrigin(): Promise<string> {
  const server: Server = createServer((request, response) => {
    response.setHeader('cf-ray', '8f00aa11bb22cc33-ORD')
    if (request.url === '/cdn-cgi/trace') {
      response.end('colo=ORD\n')
      return
    }
    response.setHeader('x-worker-version', 'v-deployed')
    response.statusCode = request.headers['x-best-serp-co-smoke-test'] === '1' ? 200 : 503
    response.end('User-agent: *\n')
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  cleanups.push(() => server.close())
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
}

/** Runs the probe until it has written `rows` samples, then stops it as the step's trap does. */
function sampleUntil(samples: string, origin: string, rows: number): Promise<string[]> {
  return new Promise((resolveRows, reject) => {
    const child = spawn('bash', [probe, samples, origin, '1'])
    const file = join(samples, 'samples.tsv')
    const timer = setInterval(() => {
      const lines = existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n') : []
      if (lines.length > rows) child.kill('SIGTERM')
    }, 50)
    child.on('error', reject)
    child.on('close', code => {
      clearInterval(timer)
      if (code === 0) resolveRows(readFileSync(file, 'utf8').trim().split('\n'))
      else reject(new Error(`the probe exited ${code} on SIGTERM`))
    })
  })
}

describe('staging smoke latency probe (#417)', () => {
  it('times the edge and the Worker on fresh connections and reports the slow samples', async () => {
    const samples = join(directory(), 'probe')
    const rows = await sampleUntil(samples, await fakeOrigin(), 2)
    expect(rows[0]).toBe(
      'time\telapsed\ttarget\tcode\tcolo\tversion\tdns\tconnect\ttls\tfirst_byte\ttotal\tcurl_exit'
    )
    const [edge, worker] = rows.slice(1).map(row => row.split('\t'))
    // Whole seconds from `date +%s`, so a loaded runner can stamp the first sample +00:01 (#433).
    expect(edge?.[1]).toMatch(/^\+\d{2}:\d{2}$/u)
    expect(edge?.slice(2, 6)).toEqual(['edge', '200', 'ORD', '-'])
    // The Worker request carries the smoke-test header, so it gets the 200.
    expect(worker?.[1]).toMatch(/^\+\d{2}:\d{2}$/u)
    expect(worker?.slice(2, 6)).toEqual(['worker', '200', 'ORD', 'v-deployed'])
    for (const row of [edge, worker]) {
      expect(row?.slice(6, 11).every(time => /^\d+\.\d+$/u.test(time))).toBe(true)
      expect(row?.[11]).toBe('0')
    }

    const summary = join(directory(), 'summary.md')
    const report = spawnSync('bash', [probe, '--report', samples], {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_STEP_SUMMARY: summary }
    })
    expect(report.status).toBe(0)
    expect(report.stdout).toMatch(/^edge {3}\d+ samples, colo ORD; first byte p50 \d/mu)
    expect(report.stdout).toMatch(/^worker \d+ samples, colo ORD; .*; slow or failed 0$/mu)
    expect(report.stdout).toContain('Slow (>= 2 s) or failed samples:\nnone')
    expect(readFileSync(summary, 'utf8')).toContain('### Staging smoke latency (#417)')
  })

  it('records a request that gets no answer, and the report lists it as failed', async () => {
    const samples = join(directory(), 'probe')
    // Nothing listens on port 9 of 127.0.0.1: curl fails to connect and records its exit code.
    const rows = await sampleUntil(samples, 'http://127.0.0.1:9', 2)
    const [edge] = rows.slice(1).map(row => row.split('\t'))
    expect(edge?.slice(2, 6)).toEqual(['edge', '000', '-', '-'])
    expect(edge?.[11]).toBe('7')
    const report = spawnSync('bash', [probe, '--report', samples], { encoding: 'utf8' })
    expect(report.status).toBe(0)
    expect(report.stdout).toMatch(/^edge {3}\d+ samples, colo -; .*slow or failed \d+$/mu)
    expect(report.stdout).toMatch(/ edge {3}000 colo - dns .* curl 7$/mu)
  })

  // PR #418 review: a stop that arrives while a request is in flight must still record it, since
  // a slow or failed request is the sample the report most needs.
  it('records the request in flight when it is stopped, then exits', async () => {
    let arrived: () => void = () => {}
    const inFlight = new Promise<void>(done => {
      arrived = done
    })
    const server: Server = createServer((request, response) => {
      response.setHeader('cf-ray', '8f00aa11bb22cc33-MEM')
      arrived()
      setTimeout(() => response.end(`colo=MEM ${request.url}\n`), 600)
    })
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
    cleanups.push(() => server.close())
    const samples = join(directory(), 'probe')
    const child = spawn('bash', [
      probe,
      samples,
      `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      '1'
    ])
    const exited = new Promise<number | null>((done, reject) => {
      child.on('error', reject)
      child.on('close', done)
    })
    await inFlight
    child.kill('SIGTERM')
    expect(await exited).toBe(0)
    const rows = readFileSync(join(samples, 'samples.tsv'), 'utf8').trim().split('\n')
    // The edge request answered 600 ms after the stop; the probe sent nothing after it.
    expect(rows).toHaveLength(2)
    const edge = rows[1]?.split('\t')
    expect(edge?.slice(2, 5)).toEqual(['edge', '200', 'MEM'])
    expect(Number(edge?.[10])).toBeGreaterThanOrEqual(0.5)
    expect(edge?.[11]).toBe('0')
  })

  it('reports nothing to see when the probe never sampled', () => {
    const report = spawnSync('bash', [probe, '--report', directory()], { encoding: 'utf8' })
    expect(report.status).toBe(0)
    expect(report.stdout).toMatch(/^No smoke latency samples in /u)
  })
})
