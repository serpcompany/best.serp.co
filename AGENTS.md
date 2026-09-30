# Repository contract for coding agents

This repository is the source of **best.serp.co**, a single Next.js OpenNext Worker on
Cloudflare backed by one D1 database per environment. D1 is the only catalog store.

## Start here

1. [Architecture](./docs/ARCHITECTURE.md) for responsibilities and boundaries.
2. [Data model](./docs/DATA_MODEL.md) for D1 ownership and publication rules.
3. [Development](./docs/DEVELOPMENT.md) for the local loop.
4. [Harness](./docs/HARNESS.md) for validation, runtime evidence, and worktrees.
5. [Deploy runbook](./docs/DEPLOY_RUNBOOK.md) before any Cloudflare operation.

## Repository map

- `apps/web/`: the best.serp.co Next.js routes and OpenNext Worker (`wrangler.jsonc`).
- `apps/web/lib/catalog/`: server-only adapter that acquires and validates the `DB`
  binding and delegates to `packages/data-ops/`.
- `apps/e2e/`: Playwright suites that run against the local or deployed Worker.
- `packages/site-config/`: the checked-in site definition (routes, copy, badges,
  sitemap layout) and site-owned content such as the About page.
- `packages/web-core/`: page, navigation, search, sitemap, and RSS building blocks.
- `packages/data-ops/`: Drizzle schema, catalog and submission queries, caching.
- `packages/design-system/`: UI primitives.
- `d1/drizzle/`: forward-only migration history applied by Wrangler.
- `d1/publications/`: reviewed catalog mutation manifests.
- `d1/artifacts/`: one-time JSON import artifacts (generated, git-ignored except the
  parity report).
- `scripts/project.ts`: the single deployment target (app, local D1, artifacts).
- `scripts/migration/`: the one-time json-directory-template → D1 import and the
  live-vs-candidate page comparison.
- `scripts/harness/`: deterministic agent feedback and runtime tooling.
- `docs/`: operating procedures.

Closer `AGENTS.md` files add local rules without replacing this contract.

## Primary commands

- `pnpm dev` / `pnpm worker:preview`: build and serve the Worker against local D1.
- `pnpm d1:local:migrate`, `pnpm d1:local:import`, `pnpm d1:local:verify`: prepare
  local D1 (run `pnpm migration:generate` first; see [Development](./docs/DEVELOPMENT.md)).
- `pnpm harness:fast` / `pnpm harness:check`: fast and full validation loops.
- `pnpm test:e2e`: Playwright against a local Worker.
- `pnpm migration:compare -- <origin>`: structural page parity against best.serp.co.
- `pnpm agent:manifest`, `pnpm agent:doctor`, `pnpm agent:dev`: machine-readable
  runtime identity, prerequisite diagnostics, and a logged isolated Worker preview.
- `pnpm worktree:new -- <name>` / `pnpm worktree:destroy -- <name>`: isolated
  worktrees with their own D1 state and port.

## Planning and implementation

GitHub Issues on `serpcompany/best.serp.co` are the source of truth for planning.
Use short-lived branches and pull requests into protected `main`; never force-push
`main`. Issues and labels never grant production, database, or deployment authority.

## Non-negotiable architecture

- Read catalog data through `apps/web/lib/catalog/repository.ts`, which delegates all
  SQL to `packages/data-ops/`. Never put catalog SQL in the app.
- Obtain the database only through the server-only OpenNext `DB` binding; fail closed
  when the binding or `D1_RUNTIME_ENV` is missing or invalid.
- Use prepared statements and bind every runtime value.
- Model tables in `packages/data-ops/src/schema.ts` and generate migrations into
  `d1/drizzle/` with `pnpm d1:generate`; `drizzle-kit push` is forbidden.
- Keep search, taxonomy, RSS, sitemap, and submission options derived from D1.
- Public URLs are part of the SEO contract: `/products/<slug>/reviews/`,
  `/products/best/<category>/`. Changing a route requires permanent redirects.
- Route production mutations through protected GitHub Actions only.

## Forbidden patterns

Do not add a catalog JSON/YAML/CSV runtime, generated browser search index, filesystem
fallback, static export, or GitHub Pages deploy path. The legacy `products.json` is an
import input read from an external checkout, never an application input.

## Completion contract

Run targeted checks while editing and `pnpm harness:check` before claiming a
substantial change is complete. For runtime behavior, capture Playwright or live-route
evidence. Production operations require the confirmations in
[the deploy runbook](./docs/DEPLOY_RUNBOOK.md); a passing local harness never grants
deployment authority.
