# Development

Install dependencies with Node 24 (`.nvmrc`) and `pnpm install`.

## Local data

Local D1 holds fixtures, not the real catalog (serpcompany/best.serp.co#311):

```bash
pnpm db:seed:local
pnpm db:verify:local
```

`db:seed:local` deletes the local state (D1, the local media bucket, the cache), applies the
migrations, and seeds fake data in a few seconds: 55 published listings in three categories
(one paginates) and an empty one, listings with and without a logo, hosted media, FAQs,
resource links, owners, claim and badge-program states, an unpublished and a never-published
listing, and three users: `admin@example.com` (allowlisted), `submitter@example.com` (a
submission in every status, a pending revision) and `owner@example.com`. Its logos are generated
PNGs hosted through the real media ingestion path. Re-running it gives the same rows; it refuses
a Worker config that is not the local one. Stop a running preview first, or restart it after.
The facts tests assert (slugs, names, counts) live in `apps/web/e2e/seed-facts.ts`, the rows in
`apps/web/e2e/fixture-seed.ts`. `db:verify:local` checks a seeded D1 against those facts.

`pnpm db:migrations:list:local` shows the migrations local D1 has not applied yet;
`pnpm db:migrate:local` applies them without touching the data.

Playwright's default server runs on the seed too (`pnpm db:seed:local && pnpm db:verify:local`,
then `pnpm preview`), and the e2e specs assert its facts
([E2E data](../apps/web/e2e/README.md#data)). The seed's clock is fixed (`SEED_NOW`) while the app
reads the real one, so a relative time it shows for a seeded row ("expires in 3 days") changes
from day to day; never assert one.

The one-time import of the real catalog and its tooling (`db:import:local`, `migration:*`) are
retired and archived in [`.archive/`](../.archive/README.md) (#315). A checkout older than that
may still hold the generated import under the ignored `d1/artifacts/`; delete it freely.

State lives under `.wrangler/drizzle-state/best-serp-co/` (a worktree's under its
`.runtime/` directory) and uses the synthetic local database in `apps/web/wrangler.jsonc`.
Wrangler names the SQLite file after the local `database_id`; `db:seed:local` starts over
when that id changes (#176).

## Run the Worker

```bash
pnpm preview
```

This builds the OpenNext Worker and serves it on http://localhost:8787 against local
D1. `pnpm dev` runs `next dev` for UI work, but only the Worker preview exercises the real D1
binding.

Listing media (#95) uses a local R2 bucket in the same state; the Worker serves it at
`/_media/<key>`, and `curl 'localhost:8787/cdn-cgi/handler/scheduled?cron=*/15+*+*+*+*'` runs the
media cron once ([Listing media](./MEDIA.md#local-development-and-tests)).

## Accounts locally

Copy `apps/web/.dev.vars.example` to `apps/web/.dev.vars` (gitignored) and set
`BETTER_AUTH_SECRET` to a random value of at least 32 characters (`openssl rand -base64 32`).
Without it the local Worker uses a random secret per isolate, so sessions end on restart.

Sign in at `/login/`. Codes are not emailed locally: the dev sender logs them, and
`GET /api/auth/dev/otp-outbox?email=<email>` returns the latest one. `admin@example.com` is the
fixture admin (and `devin@serp.co` the allowlisted owner). Cloudflare Access is off locally and
on staging; to exercise it, set `CF_ACCESS_REQUIRED=on` with `CF_ACCESS_TEAM_DOMAIN` and
`CF_ACCESS_AUD` in `.dev.vars` (which overrides vars locally) or, for staging, in
`env.staging.vars`. See [Accounts](./ACCOUNTS.md).

## Schema changes

Edit `apps/web/src/db/schema.ts`, then generate and apply a migration locally:

```bash
pnpm db:generate
pnpm db:migrate:local
```

Review the SQL and keep the D1 specifics described in
[Data model](./DATA_MODEL.md#hand-finished-migrations) (`STRICT` tables and triggers). Never use
`drizzle-kit push`. Then run `pnpm check` (lint, typecheck, `drizzle-kit check`, tests, and the
Worker build).

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

## Validation

```bash
pnpm harness:fast
pnpm test:e2e
```
