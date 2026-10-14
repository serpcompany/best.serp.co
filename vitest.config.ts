import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

/**
 * The D1, Wrangler and release contracts: they build SQLite databases, run workerd, or drive the
 * release scripts against local fixtures, so they run as their own project (`pnpm test:d1`, which
 * the D1 publication workflows run before writing anything).
 */
export const D1_TESTS = [
  'scripts/catalog-media.test.ts',
  'scripts/cloudflare-release.test.ts',
  'scripts/d1-compat.test.ts',
  'scripts/d1-drizzle-local.test.ts',
  'scripts/d1-local-state.test.ts',
  'scripts/d1-preview-http-gates.test.ts',
  'scripts/d1-publisher.sqlite.test.ts',
  'scripts/d1-remote-publisher.test.ts',
  'scripts/d1-workerd-plans.test.ts',
  'scripts/d1-workerd-queries.test.ts',
  'scripts/downloader-links-manifest.test.ts',
  'scripts/feature-listings-manifest.test.ts',
  'scripts/fixtures/scale-catalog.test.ts',
  'scripts/listing-domain-check.test.ts',
  'scripts/media-health.test.ts',
  'scripts/media-upload.test.ts',
  'scripts/mismatch-manifests.test.ts',
  'scripts/other-categories-manifest.test.ts',
  'scripts/other-retirement.test.ts',
  'scripts/r2-objects.test.ts',
  'scripts/release-promote.test.ts',
  'scripts/staging-verification.test.ts',
  'scripts/taxonomy-manifest.test.ts'
]

/** `pnpm test:clock-ahead` (#450): every project runs with the clock this many days ahead. */
const clockAhead = process.env.VITEST_CLOCK_AHEAD_DAYS

/**
 * One config for every unit test (#178): `pnpm test` runs both projects, and a new test file
 * runs without being listed anywhere. `@/` names `apps/web/src`, as in `apps/web/tsconfig.json`.
 * Playwright suites (`apps/web/e2e/*.spec.ts`) run under Playwright, not here.
 */
export default defineConfig({
  resolve: {
    alias: { '@': resolve(import.meta.dirname, 'apps/web/src') }
  },
  test: {
    setupFiles: clockAhead ? ['scripts/harness/clock-ahead.setup.ts'] : [],
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['apps/web/src/**/*.test.{ts,tsx}', 'scripts/**/*.test.ts'],
          exclude: D1_TESTS
        }
      },
      {
        extends: true,
        test: { name: 'd1', include: D1_TESTS }
      }
    ]
  }
})
