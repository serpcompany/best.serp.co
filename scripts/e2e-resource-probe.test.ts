import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const probe = resolve('scripts/e2e-resource-probe.sh')
const directories: string[] = []

function directory(): string {
  const created = mkdtempSync(join(tmpdir(), 'e2e-resource-probe-'))
  directories.push(created)
  return created
}

/** Kernel files as a 16 GB runner near the end of its memory shows them. */
function fakeProc(root: string): string {
  const proc = join(root, 'proc')
  mkdirSync(join(proc, 'pressure'), { recursive: true })
  writeFileSync(
    join(proc, 'meminfo'),
    [
      'MemTotal:       16374836 kB',
      'MemFree:          200000 kB',
      'MemAvailable:     409600 kB',
      'SwapTotal:       4194300 kB',
      'SwapFree:        1048576 kB'
    ].join('\n')
  )
  writeFileSync(join(proc, 'vmstat'), 'nr_free_pages 1\noom_kill 2\n')
  writeFileSync(
    join(proc, 'pressure', 'memory'),
    'some avg10=42.50 avg60=10.00 avg300=1.00 total=1\nfull avg10=30.25 avg60=5.00 avg300=1.00 total=1\n'
  )
  writeFileSync(join(proc, 'loadavg'), '7.91 6.00 3.00 9/900 1234\n')
  return proc
}

/** Runs the probe until it prints its first sample, then stops it as the step's trap does. */
function firstSample(samples: string, env: Record<string, string>): Promise<string> {
  return new Promise((resolveLine, reject) => {
    const child = spawn('bash', [probe, samples, '1'], { env: { ...process.env, ...env } })
    let output = ''
    child.stdout.on('data', chunk => {
      output += String(chunk)
      if (output.includes('\n')) child.kill('SIGTERM')
    })
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) resolveLine(output.split('\n')[0] as string)
      else reject(new Error(`the probe exited ${code} on SIGTERM`))
    })
  })
}

afterEach(() => {
  for (const created of directories.splice(0)) rmSync(created, { force: true, recursive: true })
})

describe('e2e resource probe', () => {
  it('prints a line per sample and keeps snapshots and peaks for the artifact', async () => {
    const root = directory()
    const samples = join(root, 'probe')
    const line = await firstSample(samples, { E2E_PROBE_PROC: fakeProc(root) })
    expect(line).toMatch(
      /^\[resource-probe\] \+00:00 mem 15591\/15991M avail 400M swap 3071\/4095M psi10 42\.50\/30\.25 oom_kill 0 load 7\.91 disk \d+% top( \S+ \d+\/\d+M){1,6}$/u
    )
    expect(readFileSync(join(samples, 'samples.log'), 'utf8')).toContain(line)
    const peak = readFileSync(join(samples, 'peak.txt'), 'utf8')
    expect(peak).toContain('Peak used: 15591 MiB of 15991 MiB; least available: 400 MiB')
    expect(peak).toContain('Peak swap: 3071 MiB of 4095 MiB; OOM kills: 0')

    const summary = join(root, 'summary.md')
    const report = spawnSync('bash', [probe, '--report', samples], {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_STEP_SUMMARY: summary }
    })
    expect(report.status).toBe(0)
    expect(report.stdout).toContain('Peak used: 15591 MiB')
    expect(readFileSync(summary, 'utf8')).toContain('### E2E runner resources (#393)')
  })

  it('still samples processes without /proc, and its report never fails the job', async () => {
    const root = directory()
    const samples = join(root, 'probe')
    const line = await firstSample(samples, { E2E_PROBE_PROC: join(root, 'missing') })
    expect(line).toMatch(
      /^\[resource-probe\] \+00:00 mem - psi10 - oom_kill - load - disk \S+ top \S+ \d+\/\d+M/u
    )
    const report = spawnSync('bash', [probe, '--report', join(root, 'never-sampled')], {
      encoding: 'utf8'
    })
    expect(report.status).toBe(0)
    expect(report.stdout).toContain('No resource probe samples')
  })
})
