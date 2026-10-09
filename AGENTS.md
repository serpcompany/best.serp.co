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

- `apps/web/`: the best.serp.co Next.js routes and OpenNext Worker (`wrangler.jsonc`); its
  code is in `apps/web/src/` (`app/`, `components/`, `lib/`, `hooks/`, `actions/`).
  `worker.ts` is the Worker entry: an epoch-keyed edge HTML cache in front of OpenNext.
- `apps/web/src/lib/catalog/`: server-only adapter that validates the `DB` binding and delegates
  to `apps/web/src/db/`; `apps/web/src/lib/admin/` does the same for the admin panel's decisions.
- `apps/web/src/lib/auth/`: Better Auth sign-in codes, `requireUser()` / `requireAdmin()`, and
  the Worker's Cloudflare Access gate on `/admin` ([Accounts](./docs/ACCOUNTS.md)).
- `apps/web/e2e/`: Playwright suites that run against the local or deployed Worker.
- `apps/web/src/lib/site/`: the checked-in site definition (routes, copy, badges, the route
  registry); `apps/web/content/` holds the MDX content (legal pages, the About page).
- `apps/web/src/db/`: Drizzle schema, catalog and submission queries, caching.
- `apps/web/src/components/ui/`: stock shadcn/ui components, added with `pnpm shadcn <name>`.
- `apps/web/drizzle/`: forward-only migration history applied by Wrangler.
- `d1/publications/`: reviewed catalog mutation manifests (staging first, then production).
- `d1/media/`: reviewed listing media upload plans (keys and sources; no image files).
- `d1/artifacts/`: one-time JSON import; the parity report and the brotli-compressed
  SQL are committed, the uncompressed SQL and batches are generated.
- `scripts/project.ts`: the single deployment target (app, local D1, artifacts).
- `scripts/migration/`: the one-time json-directory-template → D1 import and page parity.
- `scripts/harness/`: deterministic agent feedback and runtime tooling.
- `docs/`: operating procedures.

Closer `AGENTS.md` files add local rules without replacing this contract.

## Primary commands

- `pnpm preview`: build and serve the Worker against local D1 (`pnpm dev` is `next dev`).
- `pnpm db:migrate:local`, `pnpm db:import:local`, `pnpm db:verify:local`: prepare
  local D1 from the committed import (see [Development](./docs/DEVELOPMENT.md)).
- `pnpm db:generate`: generate a reviewed migration from the Drizzle schema.
- `pnpm db:migrations:list:{local,staging,production}`: read-only migration status.
  `pnpm db:migrate:{staging,production}` runs only inside the protected deploy workflows,
  and production only after Deploy Staging verified the same source tree
  (see [Release guards](./docs/RELEASE_GUARDS.md)).
- `pnpm check`: the read-only finish gate CI runs; `pnpm harness:fast` is the quicker loop.
- `pnpm cf-typegen`: regenerate `apps/web/cloudflare-env.d.ts` after a Wrangler change.
- `pnpm test` (all Vitest projects), `pnpm test:e2e` (Playwright on a local Worker); while
  editing, `pnpm exec vitest related --run <files>`.
- `pnpm migration:compare -- <origin>`: structural page parity against best.serp.co.
- `pnpm agent:manifest`, `pnpm agent:doctor`, `pnpm agent:dev`: machine-readable
  runtime identity, prerequisite diagnostics, and a logged isolated Worker preview.
- `pnpm worktree:new -- <name>` / `pnpm worktree:destroy -- <name>`: isolated
  worktrees with their own D1 state and port.

## Planning and implementation

Stage: ship

GitHub Issues on `serpcompany/best.serp.co` are the source of truth for planning.
`staging` is the base branch: branch from `origin/staging` as `issue-<n>-<slug>` and open
pull requests into `staging` (`gh pr create --base staging`); each merge deploys staging.
`main` is production and changes only by a fast-forward promotion (`pnpm release:promote`,
owner only) or a `hotfix-*` pull request ([Release guards](./docs/RELEASE_GUARDS.md#promotion)).
Rulesets require a PR and `web.yml`'s `check` and `e2e`, and block force pushes and deletion.
Agents never merge or push to `main`; the owner approves every merge. Agents never dispatch a
production workflow or a staging data workflow (catalog publication, media upload), type their
confirmations, approve a deployment, or run the emergency `pnpm deploy:*`; only the owner does.
Issues and labels never grant production, database, or deployment authority.

## Non-negotiable architecture

`scripts/architecture-guard.test.ts` checks parts of these; review covers the rest.

- Read catalog data through `apps/web/src/lib/catalog/repository.ts`, which delegates all
  SQL to `apps/web/src/db/`. Never put catalog SQL anywhere else.
- Obtain the database only through the server-only OpenNext `DB` binding; fail closed
  when the binding or `D1_RUNTIME_ENV` is missing or invalid.
- Use prepared statements and bind every runtime value.
- Model tables in `apps/web/src/db/schema.ts` and generate migrations into `apps/web/drizzle/`
  with `pnpm db:generate`; `drizzle-kit push` is forbidden. Triggers, FTS5 and `STRICT` tables
  go through `drizzle-kit generate --custom`, never hand edits to a generated migration.
- No catalog JSON/YAML/CSV runtime, generated browser search index, filesystem fallback,
  static export, or GitHub Pages deploy path. The legacy `products.json` is an import input
  read from an external checkout, never an application input.
- Keep search, taxonomy, RSS, sitemap, and submission options derived from D1.
- Public URLs are part of the SEO contract: `/products/<slug>/`,
  `/products/categories/<category>/`. Changing a route requires permanent redirects.
- Route production mutations through protected GitHub Actions only, apart from the owner's
  emergency `pnpm deploy:*` and the admin panel (`/admin`, #64): an admin's decision writes
  production D1 through the reviewed plans, behind Cloudflare Access, the allowlist, and an
  `Origin` check ([Admin panel](./docs/ADMIN_PANEL.md#the-production-write-exception)). Agents
  use neither in production; recovery is D1 Time Travel ([D1 recovery](./docs/D1_RECOVERY.md)).

## Recorded exceptions to the SERP web stack

Deliberate differences from serp's `web-stack/` standard; change one only through an issue.

- R2 is serp.co's shared `cdn` and `cdn-staging` buckets; moving would rewrite media keys.
- Email is useSend from `noreply@mail.serp.co`, the transactional-email standard's exception
  for directories on serp.co subdomains.
- One build serves every environment; the environment is read per request
  (`apps/web/src/lib/environment/request-environment.ts`), so nothing per-environment is
  prerendered.
- `orders.currency` keeps its `GLOB` CHECK: replacing it rebuilds a referenced table.
- The Stripe webhook is `/api/billing/webhook/` behind a provider-neutral `BillingProvider`
  with no Stripe SDK, until the payments audit (#156) decides. Brand icons use
  `@icons-pack/react-simple-icons` because lucide has no brand icons.

## Completion contract

Run targeted checks while editing and `pnpm check` before claiming a
substantial change is complete. For runtime behavior, capture Playwright or live-route
evidence. Production operations require the confirmations in
[the deploy runbook](./docs/DEPLOY_RUNBOOK.md); a passing local harness never grants
deployment authority.
