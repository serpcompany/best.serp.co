import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { unstable_readConfig } from 'wrangler'
import { project } from './project'

// Each environment as Wrangler resolves it for a deploy (`--env`), so inherited keys and
// per-environment overrides are both covered.
const resolved = (env?: 'production' | 'staging') =>
  unstable_readConfig({ config: resolve(project.wranglerConfigPath), env }, { hideWarnings: true })
const environments = [
  ['local (top level)', resolved()],
  ['staging', resolved('staging')],
  ['production', resolved('production')]
] as const
const deployed = environments.slice(1)

describe('Worker configuration (serp web-stack/nextjs-on-workers.md)', () => {
  // esbuild's keep_names wraps bundled functions in __name(). next-themes serializes its theme
  // function with toString() into an inline <script>, so the browser received __name(...) and
  // threw "__name is not defined" on every page before the theme applied (#198).
  it.each(environments)('turns off keep_names in %s', (_name, config) => {
    expect(config.keep_names).toBe(false)
  })

  it.each(environments)('sets the standard compatibility flags in %s', (_name, config) => {
    expect(config.compatibility_flags).toEqual(
      expect.arrayContaining(['nodejs_compat', 'global_fetch_strictly_public'])
    )
  })

  it.each(environments)('uploads source maps in %s', (_name, config) => {
    expect(config.upload_source_maps).toBe(true)
  })

  it.each(environments)('binds WORKER_SELF_REFERENCE to its own Worker in %s', (_name, config) => {
    expect(config.services).toContainEqual({
      binding: 'WORKER_SELF_REFERENCE',
      service: config.name
    })
  })

  // Providers send buyers back with tokens in the query string (serp web-stack/payments.md).
  // Local runs ship no logs, so only the deployed environments are checked.
  it.each(deployed)('keeps Workers Logs on, without query strings, in %s', (_name, config) => {
    expect(config.observability).toMatchObject({ enabled: true, redact_query_string: true })
  })
})
