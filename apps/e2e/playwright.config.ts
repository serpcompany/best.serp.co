import { defineConfig, devices } from '@playwright/test'

const selectedSiteId = process.env.E2E_SITE_ID ?? 'serp.software'
const playwrightPort = Number(
  process.env.PLAYWRIGHT_PORT ?? (selectedSiteId === 'pornvideodownloaders.com' ? 9544 : 3100)
)
const baseUrl = process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${playwrightPort}`
const defaultWebServerCommand =
  selectedSiteId === 'pornvideodownloaders.com'
    ? `cd ../.. && pnpm d1:pornvideodownloaders:local:migrate && pnpm d1:pornvideodownloaders:local:import && pnpm d1:pornvideodownloaders:local:verify && PORT=${playwrightPort} pnpm preview:pornvideodownloaders`
    : `cd ../.. && pnpm d1:local:migrate && pnpm d1:local:import && pnpm d1:local:verify && PORT=${playwrightPort} pnpm worker:preview`
const webServerCommand = process.env.PLAYWRIGHT_WEB_SERVER_COMMAND ?? defaultWebServerCommand
const useExternalServer = process.env.PLAYWRIGHT_EXTERNAL_SERVER === '1'
const workerCount = Number(process.env.E2E_WORKERS ?? 2)
const ignoredTests = [
  ...(process.env.E2E_VISUAL === '1' ? [] : ['**/visual.spec.ts']),
  ...(process.env.AGENT_CAPTURE_DIRECTORY ? [] : ['**/agent-capture.spec.ts'])
]

export default defineConfig({
  testDir: './tests',
  testIgnore: ignoredTests,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  globalTimeout: process.env.CI ? 20 * 60 * 1000 : undefined,
  workers: workerCount,
  reporter: process.env.CI || process.env.CLAUDE ? [['line'], ['html', { open: 'never' }]] : 'html',

  // Performance optimizations
  timeout: 60000, // 60 seconds per test (more generous for loaded apps)
  expect: {
    timeout: 15000 // 15 seconds for assertions
  },

  use: {
    baseURL: baseUrl,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',

    // Performance optimizations
    actionTimeout: 15000,
    navigationTimeout: 30000, // More time for navigation

    // Reduce visual noise during local development
    launchOptions: {
      slowMo: process.env.CI ? 0 : 0 // No slow motion
    }
  },
  projects: [
    // Primary desktop testing
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Optimize for speed
        launchOptions: {
          args: [
            '--disable-dev-shm-usage',
            '--disable-extensions',
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding'
          ]
        }
      }
    },

    // Mobile testing (reduced for speed)
    {
      name: 'mobile',
      testMatch: ['**/pages.spec.ts', '**/interactions.spec.ts', '**/visual.spec.ts'],
      use: {
        ...devices['Pixel 5']
      }
    }

    // Additional browsers commented out for speed
    // Uncomment for comprehensive cross-browser testing
    // {
    //   name: 'firefox',
    //   use: { ...devices['Desktop Firefox'] }
    // },
    // {
    //   name: 'webkit',
    //   use: { ...devices['Desktop Safari'] }
    // }
  ],
  webServer: useExternalServer
    ? undefined
    : {
        command: webServerCommand,
        url: baseUrl,
        reuseExistingServer: !process.env.CI,
        timeout: 360000, // D1 initialization plus the OpenNext Worker build on CI runners
        env: {
          // Minimize external dependencies for testing
          NEXT_PUBLIC_SENTRY_DSN:
            process.env.NEXT_PUBLIC_SENTRY_DSN || 'https://dummy@dummy.ingest.sentry.io/123',
          SENTRY_AUTH_TOKEN: process.env.SENTRY_AUTH_TOKEN || 'dummy_token',
          SENTRY_ORG: process.env.SENTRY_ORG || 'dummy_org',
          SENTRY_PROJECT: process.env.SENTRY_PROJECT || 'dummy_project',
          LOG_LEVEL: process.env.LOG_LEVEL || 'error',
          GITHUB_CLIENT_ID: process.env.GITHUB_CLIENT_ID || 'playwright-github-client-id',
          GITHUB_CLIENT_SECRET:
            process.env.GITHUB_CLIENT_SECRET || 'playwright-github-client-secret',
          AUTH_TRUST_HOST: process.env.AUTH_TRUST_HOST || 'true',
          NEXTAUTH_SECRET:
            process.env.NEXTAUTH_SECRET || 'playwright-nextauth-secret-playwright-nextauth-secret',
          NEXTAUTH_URL: process.env.NEXTAUTH_URL || baseUrl,
          // Faster builds
          NEXT_TELEMETRY_DISABLED: '1',
          FORCE_COLOR: '0'
        }
      }
})
