# Playwright E2E

Playwright coverage for the best.serp.co Worker. The config is `apps/web/playwright.config.ts`.

## Commands

```bash
pnpm test:e2e
pnpm test:e2e:smoke   # e2e/smoke.spec.ts + e2e/public-parity.spec.ts
pnpm test:e2e:visual  # opt-in; no committed baselines yet (see Notes)
pnpm test:e2e:ui
pnpm test:e2e:debug
```

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
- The suites with their own Worker (admin, account, badge program, claims, orders, media,
  Access lock; `e2e/*-fixture.ts`) each start on a fresh D1 and seed their own rows with the
  seed's builders (`listingStatements`, `suiteCatalogStatements`), so they run in parallel without
  counting each other's rows. The media server's D1 is the seed plus a queued logo.
- `smoke.spec.ts` and `public-parity.spec.ts` also run against staging after each deploy
  (`pnpm test:e2e:smoke`). Their catalog facts come from `e2e/catalog-sample.ts`: the seed's
  locally, the live catalog's (counts from the feed and sitemap, a listing the homepage links) on
  a deployed Worker. Every other spec asserts the seed and runs only locally.
- Shared best.serp.co facts that are not catalog data (public URL, title, route helpers) live in
  `e2e/site-fixture.ts`.

To run specs against a preview that is already running, set
`PLAYWRIGHT_EXTERNAL_SERVER=1 PLAYWRIGHT_BASE_URL=http://127.0.0.1:<port>`; its D1 must be the
seed (`pnpm agent:dev` and a fresh `pnpm db:seed:local` are). The suites with their own Worker
skip then.

## Notes

- The repo workflow only runs E2E when changes touch E2E-relevant frontend paths.
- Keep route expectations aligned with the active best.serp.co Worker and D1 contract
  (`/products/<slug>/`, `/products/categories/<category>/`, `/sitemap-*.xml`), not a removed
  starter app, the former multi-site platform, or the older llms-era route map.
- `pnpm test:e2e` is functional coverage by default. Visual snapshot coverage is opt-in with
  `pnpm test:e2e:visual` because snapshots are platform-specific and should be updated only from a
  consistent runner environment. The inherited serp.software baselines were removed; record new
  best.serp.co baselines with `E2E_VISUAL=1 pnpm --filter web exec playwright test e2e/visual.spec.ts
  --project=chromium --update-snapshots`.
