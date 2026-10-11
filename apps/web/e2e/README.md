# Playwright E2E

Playwright coverage for the best.serp.co Worker, in three runs that `pnpm test:e2e` (what CI
runs) starts one after another, each on preview Workers that serve the Worker the first builds:

- `apps/web/playwright.config.ts`: the public site, on the main preview, the two Access-lock
  Workers and the media Worker.
- `apps/web/playwright.suites.config.ts`: the suites with a Worker and D1 of their own (admin
  panel and orders, account dashboard, badge program, claims; `suiteSpecs`).
- `apps/web/playwright.staging-access.config.ts` (#359): the Worker serving as staging.

Every preview Worker (wrangler, the esbuild service it keeps for rebuilds, workerd and their
launchers) costs the CI runner about 2.5 GB, so no run starts more than four: eight at once
filled the 16 GB runner's memory and swap, and GitHub shut it down mid-suite (#111, #393). Each
run starts even when an earlier one fails, and the command fails when any does. The e2e job's
resource probe (`scripts/e2e-resource-probe.sh`) logs the runner's memory every 15 s and uploads
its samples.

## Commands

```bash
pnpm test:e2e         # all three runs, as CI does; the first one builds the Worker
pnpm --filter web test:e2e e2e/home.spec.ts                             # one public spec
pnpm build && pnpm --filter web test:e2e:suites e2e/admin-panel.spec.ts  # one suite spec
pnpm build && pnpm --filter web test:e2e:staging-access
pnpm test:e2e:smoke   # e2e/smoke.spec.ts + e2e/public-parity.spec.ts
pnpm test:e2e:visual  # opt-in; no committed baselines yet (see Notes)
pnpm test:e2e:ui
pnpm test:e2e:debug
```

Only the main run builds the Worker (`pnpm preview`). The suites and staging-access runs serve
the last build in `apps/web/.open-next/` and refuse to start without one, so run `pnpm build`
before running either on its own, or they test the build from before your edit.

## What belongs here

- spec files, fixtures and fixture servers
- E2E documentation

## What does not belong here

- checked-in `playwright-report/` output
- checked-in `test-results/` output

Those generated artifacts were moved to `_archive/legacy-e2e-artifacts/**` during the starter cleanup sweep and stay out of the tree (`apps/web/.gitignore`).

## Data

The local suite runs on the fixture seed, never the real catalog (#311, #313):

- By default Playwright runs `pnpm db:seed:local && pnpm db:verify:local` (which resets the
  local D1, in a worktree its runtime's) and then `pnpm preview` on port 3100.
- Specs assert the seed's facts from `e2e/seed-facts.ts` (its rows are in `e2e/fixture-seed.ts`):
  import them, never repeat a slug, name, or count. `e2e/listing-fixture.ts` turns the seed's
  sample listing, category, and search into paths and patterns. A spec that needs a state the
  seed lacks adds it to the seed and its facts, not to the spec.
- The seed's clock is fixed (`SEED_NOW`), but the app reads the real one: never assert a relative
  time ("expires in 3 days", "2 days ago") on a seeded row. Assert one only on a row the spec
  writes itself, at the real time.
- The specs with a Worker of their own (admin, account, badge program, claims, orders, media,
  Access lock, staging access; `e2e/*-fixture.ts`) each start on a fresh D1 and seed their own
  rows with the seed's builders (`listingStatements`, `suiteCatalogStatements`), so they run in
  parallel without counting each other's rows. The media server's D1 is the seed plus a queued
  logo. The staging-access Worker runs with `LOCAL_STAGING_ACCESS=on` and a test password, so
  it serves as staging does behind its password (#359). The media and Access-lock Workers run
  with the public specs in the main run; the admin, account, orders, badge program and claims
  suites run next, in the suites run; staging access runs last, alone.
- Specs read and write a Worker's local D1 only through `localD1`, `runStatements` and
  `workerD1` (`e2e/admin-fixture.ts`), a suite Worker's or the main preview's (`executeLocalD1`
  in `e2e/submit-fixture.ts`, #389). They go through that Worker's own D1 (Wrangler's Local
  Explorer API), never the SQLite file or `wrangler d1 execute --local`: workerd waits for no
  SQLite lock, so a Worker query that met a write from another process failed with a 500
  "internal error", or React #441 on admin pages (#200, #204). D1's own limits apply, such as
  50-byte `LIKE` patterns, and a bound statement may hold only plain `?` placeholders and
  single-quoted strings. The claims suites also start each test with the shared
  `localtest.me` code cap empty, on a fixed test auth secret (#200).
- `smoke.spec.ts` and `public-parity.spec.ts` also run against staging after each deploy
  (`pnpm test:e2e:smoke`), on its workers.dev host: `playwright.config.ts` then sends the
  smoke-test header on every request, and one smoke test checks that a request without it gets
  the 308 to staging.best.serp.co (#323). Another checks staging.best.serp.co itself, without
  the header: 401 without staging's password, indexable and self-canonical with it (#359), and
  skips when zone protection, not the Worker, answers the runner. Pages on staging write
  staging's origin, so the smoke reads which origin to expect from `x-site-environment`
  (`writtenOrigin` in `e2e/site-fixture.ts`). Their catalog facts come from `e2e/catalog-sample.ts`:
  the seed's locally, the live catalog's (counts from the feed and sitemap, a listing the
  homepage links) on a deployed Worker. Every other spec asserts the seed and runs only locally.
- Shared best.serp.co facts that are not catalog data (public URL, title, route helpers) live in
  `e2e/site-fixture.ts`.

To run specs against a preview that is already running, set
`PLAYWRIGHT_EXTERNAL_SERVER=1 PLAYWRIGHT_BASE_URL=http://127.0.0.1:<port>`; its D1 must be the
seed (`pnpm agent:dev` and a fresh `pnpm db:seed:local` are). The suites with their own Worker
skip then.

## Notes

- The repo workflow only runs E2E when changes touch E2E-relevant frontend paths.
- Keep route expectations aligned with the active best.serp.co Worker and D1 contract
  (`/products/<slug>/`, `/products/categories/<category>/`, `/products/tags/<tag>/`,
  `/best/<keyword>/`, `/sitemap-*.xml`), not a removed
  starter app, the former multi-site platform, or the older llms-era route map.
- `pnpm test:e2e` is functional coverage by default. Visual snapshot coverage is opt-in with
  `pnpm test:e2e:visual` because snapshots are platform-specific and should be updated only from a
  consistent runner environment. The inherited serp.software baselines were removed; record new
  best.serp.co baselines with `E2E_VISUAL=1 pnpm --filter web exec playwright test e2e/visual.spec.ts
  --project=chromium --update-snapshots`.
