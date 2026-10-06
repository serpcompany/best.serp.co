import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateCanonicalLocalConfig } from './d1-local-config'
import { configuredFreshD1StateRoot } from './d1-local-state'
import { project } from './project'

/**
 * Vars a local preview may override, as `NAME=value` pairs separated by commas in
 * `LOCAL_PREVIEW_VARS`: the Cloudflare Access switches, so Playwright can run the built Worker
 * with the production Access lock (apps/e2e/tests/access-lock.spec.ts), and
 * `LOCAL_BADGE_PROGRAM`, which runs the badge program on a local Worker while its flag is off
 * (apps/e2e/tests/badge-program.spec.ts; `lib/worker/scheduled.ts` ignores it anywhere but
 * local), and the orders suite's switches (apps/e2e/tests/billing.spec.ts, #68): `LOCAL_ORDERS`
 * turns orders on while `features.orders` is off, `LOCAL_STRIPE_MOCK_PORT` points billing at
 * the suite's mocked Stripe API, and `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` take the
 * suite's own test values (`lib/billing/` ignores the first two anywhere but local, and refuses a
 * live key outside production). Identity and environment vars (`SITE_ENVIRONMENT`,
 * `D1_RUNTIME_ENV`) can never be overridden here.
 */
export const LOCAL_PREVIEW_OVERRIDABLE_VARS = [
  'CF_ACCESS_AUD',
  'CF_ACCESS_REQUIRED',
  'CF_ACCESS_TEAM_DOMAIN',
  'LOCAL_BADGE_PROGRAM',
  'LOCAL_ORDERS',
  'LOCAL_STRIPE_MOCK_PORT',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET'
] as const

export function localPreviewVarArgs(value: string | undefined): string[] {
  if (!value?.trim()) return []
  return value.split(',').flatMap(pair => {
    const separator = pair.indexOf('=')
    const name = pair.slice(0, separator).trim()
    const varValue = pair.slice(separator + 1).trim()
    if (
      separator < 1 ||
      !(LOCAL_PREVIEW_OVERRIDABLE_VARS as readonly string[]).includes(name) ||
      !/^[\w.-]*$/u.test(varValue)
    ) {
      throw new Error(
        `LOCAL_PREVIEW_VARS accepts only ${LOCAL_PREVIEW_OVERRIDABLE_VARS.join(', ')} with plain values; received ${pair.trim()}.`
      )
    }
    return ['--var', `${name}:${varValue}`]
  })
}

export function canonicalPreviewCommand(): {
  args: string[]
  statePath: string
} {
  validateCanonicalLocalConfig()
  const statePath = configuredFreshD1StateRoot()
  return {
    args: [
      '--filter',
      project.appPackageName,
      'exec',
      'opennextjs-cloudflare',
      'preview',
      '--config',
      resolve(project.wranglerConfigPath),
      '--persist-to',
      statePath,
      '--port',
      process.env.PORT || '8787',
      // Exposes `/__scheduled?cron=<expression>` on the local Worker, which runs `scheduled()`
      // (the draft job and the badge program) on demand; Cron Triggers never fire locally.
      '--test-scheduled',
      ...localPreviewVarArgs(process.env.LOCAL_PREVIEW_VARS)
    ],
    statePath
  }
}

export function runCanonicalPreview(): void {
  const command = canonicalPreviewCommand()
  const result = spawnSync('pnpm', command.args, { env: process.env, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status) process.exitCode = result.status
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const extra = process.argv.slice(2).filter(value => value !== '--')
    if (extra.length > 0) {
      throw new Error(
        `Local preview takes no arguments (received ${extra.join(' ')}); it always serves ${project.domain} from the canonical local D1 state.`
      )
    }
    runCanonicalPreview()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
