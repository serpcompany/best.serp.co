/**
 * The two extra local Workers `playwright.config.ts` starts for the Cloudflare Access lock
 * (serpcompany/best.serp.co#60): the same build as the main preview, each with its own empty
 * local D1, run with `CF_ACCESS_REQUIRED=on` the way production always runs.
 *
 * - `unconfigured`: no team domain or AUD tag, like production before the owner sets them.
 * - `configured`: a test team domain and AUD tag (never the real ones), so a request without a
 *   valid `Cf-Access-Jwt-Assertion` reaches the JWT check and is refused.
 */
const playwrightPort = Number(process.env.PLAYWRIGHT_PORT ?? 3100)

export const ACCESS_TEST_TEAM_DOMAIN = 'best-serp-co-e2e.cloudflareaccess.com'
export const ACCESS_TEST_AUD = '0123456789abcdef'.repeat(4)

/** Only when Playwright starts its own servers (not against an external or deployed Worker). */
export const accessLockServersEnabled =
  process.env.PLAYWRIGHT_EXTERNAL_SERVER !== '1' &&
  !process.env.PLAYWRIGHT_BASE_URL &&
  !process.env.PLAYWRIGHT_WEB_SERVER_COMMAND

export const accessLockServers = {
  configured: {
    port: playwrightPort + 2,
    vars: `CF_ACCESS_REQUIRED=on,CF_ACCESS_TEAM_DOMAIN=${ACCESS_TEST_TEAM_DOMAIN},CF_ACCESS_AUD=${ACCESS_TEST_AUD}`
  },
  unconfigured: {
    port: playwrightPort + 1,
    vars: 'CF_ACCESS_REQUIRED=on'
  }
} as const

export function accessLockOrigin(server: keyof typeof accessLockServers): string {
  return `http://127.0.0.1:${accessLockServers[server].port}`
}

/**
 * Serves the already-built Worker (the main web server builds it first) on its own port, with
 * a fresh, migrated local D1 so it never shares SQLite files with the main preview.
 */
export function accessLockServerCommand(server: keyof typeof accessLockServers): string {
  const { port, vars } = accessLockServers[server]
  return [
    'cd ../..',
    'state="$(mktemp -d)"',
    'HARNESS_D1_STATE_DIRECTORY="$state" pnpm db:migrate:local',
    `HARNESS_D1_STATE_DIRECTORY="$state" PORT=${port} LOCAL_PREVIEW_VARS="${vars}" pnpm tsx scripts/d1-local-preview.ts`
  ].join(' && ')
}
