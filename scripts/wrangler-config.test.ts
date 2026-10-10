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

  // The Web Analytics site token is production's alone (#170), and a pasted value must be a
  // token: the root layout renders no beacon for anything else, silently.
  it('sets CF_WEB_ANALYTICS_TOKEN only in production, and only as a site token', () => {
    for (const [name, config] of environments.slice(0, 2)) {
      expect(config.vars.CF_WEB_ANALYTICS_TOKEN, name).toBeUndefined()
    }
    // The same pattern `analyticsForRequest` accepts (apps/web/src/lib/environment). Set since
    // 2026-10-09: the best.serp.co site in the SERP account's Web Analytics (docs/TELEMETRY.md).
    expect(resolved('production').vars.CF_WEB_ANALYTICS_TOKEN).toMatch(/^[0-9a-f]{32}$/u)
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

  // Canonical hosts (serp environment-configuration.md): each deployed Worker keeps its
  // workers.dev host for CI and no preview URLs. Staging declares its branded host as a Custom
  // Domain (#323); production's best.serp.co is still attached in the dashboard until #192.
  it.each(deployed)('keeps workers.dev on and preview URLs off in %s', (_name, config) => {
    expect(config.workers_dev).toBe(true)
    expect(config.preview_urls).toBe(false)
  })

  it('routes only staging.best.serp.co, as a Custom Domain of the staging Worker', () => {
    expect(resolved('staging').routes).toEqual([
      { custom_domain: true, pattern: new URL(project.remote.staging.origin).host }
    ])
    expect(project.remote.staging.origin).toBe('https://staging.best.serp.co')
    expect(resolved('production').routes ?? []).toEqual([])
    expect(resolved().routes ?? []).toEqual([])
  })

  // Providers send buyers back with tokens in the query string (serp web-stack/payments.md).
  // Local runs ship no logs, so only the deployed environments are checked.
  it.each(deployed)('keeps Workers Logs on, without query strings, in %s', (_name, config) => {
    expect(config.observability).toMatchObject({ enabled: true, redact_query_string: true })
  })
})
