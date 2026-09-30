# Playwright E2E Package

This workspace contains Playwright coverage for the active web app.

## Commands

```bash
pnpm test:e2e
pnpm test:e2e:smoke
pnpm test:e2e:visual
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
- Keep route expectations aligned with the active `serp.software` Worker and D1
  contract, not a removed starter app or the older llms-era route map.
- `pnpm test:e2e` is functional coverage by default. Visual snapshot coverage is opt-in with
  `pnpm test:e2e:visual` because snapshots are platform-specific and should be updated only from a
  consistent runner environment.
