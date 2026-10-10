import { defineConfig, devices } from '@playwright/test'
import {
  stagingAccessOrigin,
  stagingAccessServerCommand,
  stagingAccessSuiteEnabled
} from './e2e/staging-access-fixture'
import base from './playwright.config'

/**
 * The staging-access suite's own run (#359): a local Worker that serves as staging, behind its
 * password (`e2e/staging-access-fixture.ts`). `pnpm test:e2e` runs it after the main run
 * (`playwright.config.ts`), whose eight preview Workers have stopped by then: a ninth beside
 * them exhausts the CI runner's memory (#111). It serves the Worker the main run built.
 */
export default defineConfig({
  ...base,
  testMatch: '**/staging-access.spec.ts',
  testIgnore: [],
  outputDir: 'test-results/staging-access',
  reporter:
    process.env.CI || process.env.CLAUDE
      ? [['line'], ['html', { open: 'never', outputFolder: 'playwright-report/staging-access' }]]
      : [['html', { outputFolder: 'playwright-report/staging-access' }]],
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // robots.txt is exempt from the password, so it answers the readiness probe.
  webServer: stagingAccessSuiteEnabled
    ? [
        {
          command: stagingAccessServerCommand(),
          url: `${stagingAccessOrigin()}/robots.txt`,
          reuseExistingServer: !process.env.CI,
          timeout: 180000,
          env: { FORCE_COLOR: '0', LOG_LEVEL: 'error' }
        }
      ]
    : undefined
})
