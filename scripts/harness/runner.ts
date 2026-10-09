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
    args: ['exec', 'vitest', 'run', '--project', 'unit', 'apps/web/src/db'],
    remediation:
      'Fix the shared catalog contract, isolation, projection, cache, telemetry, or benchmark failure. See docs/DATA_MODEL.md.'
  },
  {
    name: 'D1 contracts',
    command: 'pnpm',
    args: ['test:d1'],
    remediation: 'Fix the schema, publisher, seed, or environment contract. See docs/DATA_MODEL.md.'
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
    name: 'lint',
    command: 'pnpm',
    args: ['lint'],
    remediation:
      'Fix the Biome or forbidden-link findings; pnpm lint:fix applies Biome fixes, so review its diff.'
  },
  {
    name: 'database migrations',
    command: 'pnpm',
    args: ['db:check'],
    remediation:
      'Fix the migration history drizzle-kit reports; never edit generated SQL by hand. See docs/DATA_MODEL.md.'
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
    args: ['tsx', 'scripts/d1-local-config.ts'],
    remediation:
      'Restore the isolated local Worker and D1 identity in apps/web/wrangler.jsonc. See docs/DEPLOY_RUNBOOK.md.'
  },
  {
    name: 'Cloudflare types',
    command: 'pnpm',
    args: ['--filter', 'web', 'cf-typegen:check'],
    remediation:
      'Run pnpm cf-typegen after changing apps/web/wrangler.jsonc or upgrading Wrangler, and commit apps/web/cloudflare-env.d.ts.'
  },
  {
    name: 'OpenNext Worker build',
    command: 'pnpm',
    args: ['build'],
    remediation: 'Fix the Worker build before attempting any protected deployment.'
  }
]

export function stepsForProfile(
  profile: 'fast' | 'full',
  env: Partial<NodeJS.ProcessEnv> = process.env
): HarnessStep[] {
  if (profile === 'fast') return sharedSteps
  // On a push, CI's deploy job builds the commit, so the check there leaves the build to it
  // (.github/workflows/web.yml): each commit is built once.
  const full = [...sharedSteps, ...fullOnlySteps]
  return env.HARNESS_SKIP_BUILD === '1'
    ? full.filter(step => step.name !== 'OpenNext Worker build')
    : full
}

/**
 * The environment each step runs in. HARNESS_SKIP_BUILD picks the steps (above); the steps' own
 * tests must not see it, or a test that checks the step list would run with the build skipped.
 */
export function stepEnvironment<Env extends Partial<NodeJS.ProcessEnv>>(env: Env): Env {
  // Node leaves a variable set to undefined out of the child's environment.
  return {
    ...env,
    CI: env.CI || '1',
    FORCE_COLOR: env.FORCE_COLOR || '0',
    HARNESS_SKIP_BUILD: undefined
  }
}

export function runHarness(profile: 'fast' | 'full'): void {
  const startedAt = Date.now()
  const steps = stepsForProfile(profile)
  console.log(`Harness ${profile}: ${steps.length} deterministic checks`)

  const env = stepEnvironment(process.env)
  for (const [index, step] of steps.entries()) {
    console.log(`\n[${index + 1}/${steps.length}] ${step.name}`)
    const result = spawnSync(step.command, step.args, {
      cwd: resolve('.'),
      env,
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
