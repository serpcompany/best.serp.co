import { defineConfig } from '@playwright/test'
import {
  accountServer,
  adminOrigin,
  adminServerCommand,
  adminSuiteEnabled
} from './e2e/admin-fixture'
import { badgeOrigin, badgeServerCommand, badgeSuiteEnabled } from './e2e/badge-program-fixture'
import { claimsOrigin, claimsServerCommand, claimsSuiteEnabled } from './e2e/claims-fixture'
import base, { suiteSpecs } from './playwright.config'

/**
 * The suites with a preview Worker and D1 of their own (admin panel and orders, account dashboard,
 * badge program, claims; `e2e/*-fixture.ts`), in their own run after the main one (#393).
 * `pnpm test:e2e` runs the main run, this one, then the staging-access run
 * (`playwright.staging-access.config.ts`), so no more than four preview Workers run at once:
 * eight at once filled the CI runner's 16 GB and its swap, and GitHub shut it down mid-suite
 * (#393). The suites serve the Worker the main run built.
 */
const builtWorker = `test -f .open-next/worker.js || { echo 'No built Worker: pnpm build' >&2; exit 1; }`
const suiteServer = (command: string, origin: string) => ({
  // The main run builds the Worker (`pnpm test:e2e`); alone, build it first (`pnpm build`).
  command: `${builtWorker} && ${command}`,
  url: `${origin}/robots.txt`,
  reuseExistingServer: !process.env.CI,
  timeout: 180000,
  env: { FORCE_COLOR: '0', LOG_LEVEL: 'error' }
})

const servers = [
  // The admin panel and account dashboard suites' Workers and D1s (e2e/admin-fixture.ts): both
  // publish listings and add admins. The orders suite shares the admin one (e2e/orders-worker.ts).
  ...(adminSuiteEnabled
    ? [undefined, accountServer].map(server =>
        suiteServer(adminServerCommand(server), adminOrigin(server))
      )
    : []),
  // The badge program suite's own Worker and D1, with the program on (#66).
  ...(badgeSuiteEnabled ? [suiteServer(badgeServerCommand(), badgeOrigin())] : []),
  // The claims suite's own Worker and D1, with claims and the badge program on (#67).
  ...(claimsSuiteEnabled ? [suiteServer(claimsServerCommand(), claimsOrigin())] : [])
]

export default defineConfig({
  ...base,
  testMatch: suiteSpecs,
  testIgnore: [],
  // Only the desktop project: the mobile one's own testMatch would add visual.spec.ts here.
  projects: base.projects?.filter(project => project.name === 'chromium'),
  outputDir: 'test-results/suites',
  reporter:
    process.env.CI || process.env.CLAUDE
      ? [['line'], ['html', { open: 'never', outputFolder: 'playwright-report/suites' }]]
      : [['html', { outputFolder: 'playwright-report/suites' }]],
  webServer: servers.length > 0 ? servers : undefined
})
