import { defineConfig, devices } from '@playwright/test'
import {
  accessLockOrigin,
  accessLockServerCommand,
  accessLockServersEnabled
} from './e2e/access-lock-fixture'
import {
  accountServer,
  adminOrigin,
  adminServerCommand,
  adminSuiteEnabled
} from './e2e/admin-fixture'
import { badgeOrigin, badgeServerCommand, badgeSuiteEnabled } from './e2e/badge-program-fixture'
import { claimsOrigin, claimsServerCommand, claimsSuiteEnabled } from './e2e/claims-fixture'
import { mediaOrigin, mediaServerCommand, mediaServerEnabled } from './e2e/media-fixture'

const playwrightPort = Number(process.env.PLAYWRIGHT_PORT ?? 3100)
const baseUrl = process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${playwrightPort}`
// Reset local D1 to the fixture seed (#311, #313), check its facts, then build and serve the Worker.
const defaultWebServerCommand = `cd ../.. && pnpm db:seed:local && pnpm db:verify:local && PORT=${playwrightPort} pnpm preview`
const webServerCommand = process.env.PLAYWRIGHT_WEB_SERVER_COMMAND ?? defaultWebServerCommand
const useExternalServer = process.env.PLAYWRIGHT_EXTERNAL_SERVER === '1'
const workerCount = Number(process.env.E2E_WORKERS ?? 2)
const ignoredTests = [
  ...(process.env.E2E_VISUAL === '1' ? [] : ['**/visual.spec.ts']),
  ...(process.env.AGENT_CAPTURE_DIRECTORY ? [] : ['**/agent-capture.spec.ts'])
]

export default defineConfig({
  testDir: './e2e',
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
  // Web servers start in order: the first builds the Worker, the Access-lock servers
  // (e2e/access-lock-fixture.ts) then serve that build with CF_ACCESS_REQUIRED=on, and the
  // media server (e2e/media-fixture.ts) serves it on its own seeded local D1 and R2.
  webServer: useExternalServer
    ? undefined
    : [
        {
          command: webServerCommand,
          url: baseUrl,
          reuseExistingServer: !process.env.CI,
          timeout: 360000, // The fixture seed plus the OpenNext Worker build on CI runners
          env: {
            // Sentry stays off in E2E: no DSN, so no events, and no token, so no upload (#48).
            NEXT_PUBLIC_SENTRY_DSN: '',
            SENTRY_AUTH_TOKEN: '',
            LOG_LEVEL: process.env.LOG_LEVEL || 'error',
            // Faster builds
            NEXT_TELEMETRY_DISABLED: '1',
            FORCE_COLOR: '0'
          }
        },
        ...(accessLockServersEnabled
          ? (['unconfigured', 'configured'] as const).map(server => ({
              command: accessLockServerCommand(server),
              url: `${accessLockOrigin(server)}/robots.txt`,
              reuseExistingServer: !process.env.CI,
              timeout: 180000,
              env: { FORCE_COLOR: '0', LOG_LEVEL: 'error' }
            }))
          : []),
        // The admin panel and account dashboard suites' own Workers and D1s
        // (e2e/admin-fixture.ts): both publish listings and add admins.
        ...(adminSuiteEnabled
          ? [undefined, accountServer].map(server => ({
              command: adminServerCommand(server),
              url: `${adminOrigin(server)}/robots.txt`,
              reuseExistingServer: !process.env.CI,
              timeout: 180000,
              env: { FORCE_COLOR: '0', LOG_LEVEL: 'error' }
            }))
          : []),
        // The badge program suite's own Worker and D1, with the program on (#66).
        ...(badgeSuiteEnabled
          ? [
              {
                command: badgeServerCommand(),
                url: `${badgeOrigin()}/robots.txt`,
                reuseExistingServer: !process.env.CI,
                timeout: 180000,
                env: { FORCE_COLOR: '0', LOG_LEVEL: 'error' }
              }
            ]
          : []),
        // Hosted listing media on a seeded local D1 and R2 (e2e/media-fixture.ts).
        ...(mediaServerEnabled
          ? [
              {
                command: mediaServerCommand(),
                url: `${mediaOrigin}/robots.txt`,
                reuseExistingServer: !process.env.CI,
                timeout: 300000,
                env: { FORCE_COLOR: '0', LOG_LEVEL: 'error' }
              }
            ]
          : []),
        // The claims suite's own Worker and D1, with claims and the badge program on (#67).
        ...(claimsSuiteEnabled
          ? [
              {
                command: claimsServerCommand(),
                url: `${claimsOrigin()}/robots.txt`,
                reuseExistingServer: !process.env.CI,
                timeout: 180000,
                env: { FORCE_COLOR: '0', LOG_LEVEL: 'error' }
              }
            ]
          : [])
      ]
})
