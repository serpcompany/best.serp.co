# Development

Install dependencies with Node 24 (`.nvmrc`) and `pnpm install`.

## Local catalog

Local D1 is seeded from the committed import (`d1/artifacts/best-serp-co-v1.sql.br`,
checked against the parity report):

```bash
pnpm db:migrate:local
pnpm db:import:local
pnpm db:verify:local
```

`pnpm db:migrations:list:local` shows the migrations local D1 has not applied yet.

The import is the real public catalog (3,422 listings, no submissions or other user data),
which the parity comparison and the Playwright suites rely on. It is a documented exception
to the database standard's fake/fixture rule (owner decision a in serpcompany/best.serp.co#42).
Submissions and any future user data use fixtures only; see [Data model](./DATA_MODEL.md).

To rebuild the artifacts from the source, check out `serpcompany/json-directory-template`
at `25e2a8d` and run
`pnpm migration:generate -- --source-root ../json-directory --site-id serp.co`; it must
reproduce the committed parity report exactly.

State lives under `.wrangler/drizzle-state/best-serp-co/` and uses the synthetic
local database in `apps/web/wrangler.jsonc`. Repeating `migrate` or `import` after a
successful import is a no-op.

## Run the Worker

```bash
pnpm dev
```

This builds the OpenNext Worker and serves it on http://localhost:8787 against local
D1. `pnpm --filter web dev` runs `next dev` for UI work, but only the Worker preview
exercises the real D1 binding.

## Accounts locally

Copy `apps/web/.dev.vars.example` to `apps/web/.dev.vars` (gitignored) and set
`BETTER_AUTH_SECRET` to a random value of at least 32 characters (`openssl rand -base64 32`).
Without it the local Worker uses a random secret per isolate, so sessions end on restart.

Sign-in codes are not emailed locally: the dev sender logs them, and
`GET /api/auth/dev/otp-outbox?email=<email>` returns the latest one. `devin@serp.co` is the
seeded admin. Cloudflare Access is off locally and on staging; to exercise it, set
`CF_ACCESS_REQUIRED=on` with `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` in `.dev.vars`
(which overrides vars locally) or, for staging, in `env.staging.vars`. See
[Accounts](./ACCOUNTS.md).

## Schema changes

Edit `packages/data-ops/src/schema.ts`, then generate and apply a migration locally:

```bash
pnpm db:generate
pnpm db:migrate:local
```

Review the SQL and keep the D1 specifics described in [Data model](./DATA_MODEL.md)
(`STRICT` tables and triggers). Never use `drizzle-kit push`. Then run
`pnpm harness:check` (typecheck, tests, and the Worker build).

After the pull request merges into `staging`, Deploy Staging applies the migration to staging
(`pnpm db:migrate:staging` in the workflow). When the owner promotes `staging` to `main`,
Deploy Production sees the pending migration, backs up production D1, and applies the same
migration, only after Deploy Staging verified that source tree. Check either remote database
read-only with `pnpm db:migrations:list:staging` or `pnpm db:migrations:list:production`
after `wrangler login`; see [Release guards](./RELEASE_GUARDS.md).

## Email

Locally, email is never sent: each message is written to the Worker output as an
`email_logged` line (recipient, subject, text body). Apply migrations first so the
`email_deliveries` ledger exists. Environment behavior, the template contract, and the owner
prerequisites for staging and production are in [Email](./EMAIL.md).

## Parity against the live site

```bash
pnpm migration:compare -- http://localhost:8787 --sample 60
```

This compares status, title, h1, canonical path, meta description, JSON-LD types, and
FAQ count for sampled pages between https://best.serp.co and the candidate origin.

## Validation

```bash
pnpm harness:fast
pnpm test:e2e
```
