import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

interface HarnessStep {
  command: string
  args: string[]
  name: string
  remediation: string
}

const sharedSteps: HarnessStep[] = [
  {
    name: 'documentation health',
    command: 'pnpm',
    args: ['docs:check'],
    remediation: 'Repair the reported path, link, command, or skill contract. See docs/HARNESS.md.'
  },
  {
    name: 'D1 architecture guard',
    command: 'pnpm',
    args: ['exec', 'vitest', 'run', 'scripts/architecture-guard.test.ts'],
    remediation: 'Remove the forbidden catalog path or dependency. See docs/ARCHITECTURE.md.'
  },
  {
    name: 'catalog data operations',
    command: 'pnpm',
    args: ['--filter', '@serpdirectory/data-ops', 'test'],
    remediation:
      'Fix the shared catalog contract, isolation, projection, cache, telemetry, or benchmark failure. See docs/DATA_MODEL.md.'
  },
  {
    name: 'D1 contracts',
    command: 'pnpm',
    args: ['test:d1'],
    remediation:
      'Fix the schema, publisher, parity, or environment contract. See docs/DATA_MODEL.md.'
  },
  {
    name: 'TypeScript boundaries',
    command: 'pnpm',
    args: ['typecheck'],
    remediation: 'Fix the reported type boundary; do not bypass it with unsafe casts.'
  }
]

const fullOnlySteps: HarnessStep[] = [
  {
    name: 'changed-file Biome policy',
    command: 'pnpm',
    args: ['tsx', 'scripts/harness/biome-changed.ts'],
    remediation:
      'Format or correct the reported changed files so the local result matches PR CI. See docs/HARNESS.md.'
  },
  {
    name: 'read-only lint',
    command: 'pnpm',
    args: ['lint'],
    remediation:
      'Fix lint findings, or use pnpm lint:fix intentionally and review its complete diff.'
  },
  {
    name: 'repository tests',
    command: 'pnpm',
    args: ['test:repo'],
    remediation:
      'Run the failing Vitest file directly and preserve its remediation-oriented assertion.'
  },
  {
    name: 'Cloudflare configuration',
    command: 'pnpm',
    args: ['worker:config:validate'],
    remediation:
      'Restore environment isolation in the Wrangler configurations. See docs/DEPLOY_RUNBOOK.md.'
  },
  {
    name: 'OpenNext Worker build',
    command: 'pnpm',
    args: ['worker:build'],
    remediation: 'Fix the Worker build before attempting any protected deployment.'
  }
]

export function stepsForProfile(profile: 'fast' | 'full'): HarnessStep[] {
  return profile === 'fast' ? sharedSteps : [...sharedSteps, ...fullOnlySteps]
}

export function runHarness(profile: 'fast' | 'full'): void {
  const startedAt = Date.now()
  const steps = stepsForProfile(profile)
  console.log(`Harness ${profile}: ${steps.length} deterministic checks`)

  for (const [index, step] of steps.entries()) {
    console.log(`\n[${index + 1}/${steps.length}] ${step.name}`)
    const result = spawnSync(step.command, step.args, {
      cwd: resolve('.'),
      env: {
        ...process.env,
        CI: process.env.CI || '1',
        FORCE_COLOR: process.env.FORCE_COLOR || '0'
      },
      stdio: 'inherit'
    })
    if (result.status !== 0) {
      console.error(`\nHarness stopped at "${step.name}".`)
      console.error(`Remediation: ${step.remediation}`)
      process.exitCode = result.status || 1
      return
    }
  }

  console.log(`\nHarness ${profile} passed in ${((Date.now() - startedAt) / 1000).toFixed(1)}s.`)
}

function main(): void {
  const profile = process.argv[2]
  if (profile !== 'fast' && profile !== 'full') {
    throw new Error('Usage: pnpm tsx scripts/harness/runner.ts <fast|full>')
  }
  runHarness(profile)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main()
