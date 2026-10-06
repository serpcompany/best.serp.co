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
  `worker.ts` is the Worker entry: an epoch-keyed edge HTML cache in front of OpenNext.
- `apps/web/lib/catalog/`: server-only adapter that acquires and validates the `DB`
  binding and delegates to `packages/data-ops/`. `apps/web/lib/admin/` does the same for the
  admin panel's decisions.
- `apps/web/lib/auth/`: Better Auth sign-in codes, `requireUser()` / `requireAdmin()`, and
  the Worker's Cloudflare Access gate on `/admin` ([Accounts](./docs/ACCOUNTS.md)).
- `apps/e2e/`: Playwright suites that run against the local or deployed Worker.
- `packages/site-config/`: the checked-in site definition (routes, copy, badges,
  sitemap layout) and site-owned content such as the About page.
- `packages/web-core/`: page, navigation, search, sitemap, and RSS building blocks.
- `packages/data-ops/`: Drizzle schema, catalog and submission queries, caching.
- `packages/design-system/`: UI primitives.
- `d1/drizzle/`: forward-only migration history applied by Wrangler.
- `d1/publications/`: reviewed catalog mutation manifests (staging first, then production).
- `d1/media/`: reviewed listing media upload plans (keys and sources; no image files).
- `d1/artifacts/`: one-time JSON import; the parity report and the brotli-compressed
  SQL are committed, the uncompressed SQL and batches are generated.
- `scripts/project.ts`: the single deployment target (app, local D1, artifacts).
- `scripts/migration/`: the one-time json-directory-template → D1 import and the
  live-vs-candidate page comparison.
- `scripts/harness/`: deterministic agent feedback and runtime tooling.
- `docs/`: operating procedures.

Closer `AGENTS.md` files add local rules without replacing this contract.

## Primary commands

- `pnpm dev` / `pnpm worker:preview`: build and serve the Worker against local D1.
- `pnpm db:migrate:local`, `pnpm db:import:local`, `pnpm db:verify:local`: prepare
  local D1 from the committed import (see [Development](./docs/DEVELOPMENT.md)).
- `pnpm db:generate`: generate a reviewed migration from the Drizzle schema.
- `pnpm db:migrations:list:{local,staging,production}`: read-only migration status.
  `pnpm db:migrate:{staging,production}` runs only inside the protected deploy workflows,
  and production only after Deploy Staging verified the same source tree
  (see [Release guards](./docs/RELEASE_GUARDS.md)).
- `pnpm harness:fast` / `pnpm harness:check`: fast and full validation loops.
- `pnpm test:e2e`: Playwright against a local Worker.
- `pnpm migration:compare -- <origin>`: structural page parity against best.serp.co.
- `pnpm agent:manifest`, `pnpm agent:doctor`, `pnpm agent:dev`: machine-readable
  runtime identity, prerequisite diagnostics, and a logged isolated Worker preview.
- `pnpm worktree:new -- <name>` / `pnpm worktree:destroy -- <name>`: isolated
  worktrees with their own D1 state and port.

## Planning and implementation

GitHub Issues on `serpcompany/best.serp.co` are the source of truth for planning.
`staging` is the base branch: branch from `origin/staging` as `issue-<n>-<slug>` and open
pull requests into `staging` (`gh pr create --base staging`); each merge deploys staging.
`main` is production and changes only by the owner's `staging` → `main` promotion (a merge
commit) or a `hotfix-*` pull request ([Release guards](./docs/RELEASE_GUARDS.md#promotion)).
Rulesets require a PR and the five PR Review checks, and block force pushes and deletion.
Agents never merge; the owner approves every merge. Agents never dispatch a production
workflow or a staging data workflow (catalog publication, media upload), type their
confirmations, or approve a deployment; only the owner does.
Issues and labels never grant production, database, or deployment authority.

## Non-negotiable architecture

- Read catalog data through `apps/web/lib/catalog/repository.ts`, which delegates all
  SQL to `packages/data-ops/`. Never put catalog SQL in the app.
- Obtain the database only through the server-only OpenNext `DB` binding; fail closed
  when the binding or `D1_RUNTIME_ENV` is missing or invalid.
- Use prepared statements and bind every runtime value.
- Model tables in `packages/data-ops/src/schema.ts` and generate migrations into
  `d1/drizzle/` with `pnpm db:generate`; `drizzle-kit push` is forbidden.
- Keep search, taxonomy, RSS, sitemap, and submission options derived from D1.
- Public URLs are part of the SEO contract: `/products/<slug>/`,
  `/products/categories/<category>/`. Changing a route requires permanent redirects.
- Route production mutations through protected GitHub Actions only. The one exception is the
  admin panel (`/admin`, #64): an admin's decision writes production D1 from the Worker
  through the reviewed plans, behind Cloudflare Access, the allowlist, and an `Origin` check
  ([Admin panel](./docs/ADMIN_PANEL.md#the-production-write-exception)). Agents never use it
  on production; recovery is D1 Time Travel ([D1 recovery](./docs/D1_RECOVERY.md)).

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
