# Playwright E2E Package

This workspace contains Playwright coverage for the active web app.

## Commands

```bash
pnpm test:e2e
pnpm test:e2e:smoke   # tests/smoke.spec.ts + tests/public-parity.spec.ts
pnpm test:e2e:visual  # opt-in; no committed baselines yet (see Notes)
pnpm test:e2e:ui
pnpm test:e2e:debug
```

## What belongs here

- Playwright config
- source test files under `tests/**`
- package-level test documentation

## What does not belong here

- checked-in `playwright-report/` output
- checked-in `test-results/` output

Those generated artifacts were moved to `_archive/legacy-e2e-artifacts/**` during the starter cleanup sweep and should stay out of the active package tree.

## Notes

- The repo workflow only runs E2E when changes touch E2E-relevant frontend paths.
- Keep route expectations aligned with the active best.serp.co Worker and D1 contract
  (`/products/<slug>/`, `/products/categories/<category>/`, `/sitemap-*.xml`), not a removed
  starter app, the former multi-site platform, or the older llms-era route map. Shared best.serp.co
  facts (catalog counts, public URL, route helpers) live in `tests/site-fixture.ts`.
- By default Playwright migrates, imports, and verifies the local D1 catalog and then starts
  `pnpm worker:preview` on port 3100. To reuse an already running preview instead, set
  `PLAYWRIGHT_EXTERNAL_SERVER=1 PLAYWRIGHT_BASE_URL=http://localhost:8787`.
- `pnpm test:e2e` is functional coverage by default. Visual snapshot coverage is opt-in with
  `pnpm test:e2e:visual` because snapshots are platform-specific and should be updated only from a
  consistent runner environment. The inherited serp.software baselines were removed; record new
  best.serp.co baselines with `E2E_VISUAL=1 pnpm exec playwright test tests/visual.spec.ts
  --project=chromium --update-snapshots`.
