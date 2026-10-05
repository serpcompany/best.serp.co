# Database commands and release guards

How database commands name their targets, and how a production release proves that staging
verified the same commit first. Environments, workflows, and the release procedure itself are
in the [deploy runbook](./DEPLOY_RUNBOOK.md).

## Database commands

Every database command names its target, as the database standard requires. There is no
ambiguous `db:migrate`.

| Command | Target | Does |
|---|---|---|
| `pnpm db:generate` | none | `drizzle-kit generate` into `d1/drizzle/` |
| `pnpm db:migrations:list:local` | local D1 | `wrangler d1 migrations list --local`: migrations not applied yet |
| `pnpm db:migrate:local` | local D1 | `wrangler d1 migrations apply --local` |
| `pnpm db:import:local`, `pnpm db:verify:local` | local D1 | Seed the reviewed initial catalog and prove exact parity |
| `pnpm db:publish:local -- <manifest>` | local D1 | Apply a `d1/publications/` manifest |
| `pnpm db:migrations:list:staging` | staging D1 | Read-only: applied, pending, and unknown migrations |
| `pnpm db:migrate:staging` | staging D1 | `cloudflare-release.ts migrate staging`; runs only in `deploy-staging.yml` |
| `pnpm db:migrations:list:production` | production D1 | Read-only: applied, pending, and unknown migrations |
| `pnpm db:migrate:production` | production D1 | `cloudflare-release.ts migrate production`; runs only in `deploy-production.yml` with the typed confirmation, after Deploy Staging verified the commit |
| `pnpm db:publish:production`, `pnpm db:approve:production`, `pnpm db:notify:production` | production D1 | Data operations; each runs only in its own workflow |

The remote `migrations:list` commands run `cloudflare-release.ts list-migrations <env>`, which
reads the ledger with `wrangler d1 execute --remote --env <env>` and a `SELECT`. They do not
call `wrangler d1 migrations list`, because Wrangler's list first runs
`CREATE TABLE IF NOT EXISTS` on the ledger table. They work from a maintainer machine after
`wrangler login`.

Every D1 binding in `apps/web/wrangler.jsonc` declares `migrations_dir: "../../d1/drizzle"`
and `migrations_table: "d1_migrations"`. `pnpm worker:config:validate` and every
`cloudflare-release.ts` command refuse a binding that drifts.

## Staging before production

Deploy Production and Bootstrap Production D1 release only a commit that Deploy Staging has
verified. A commit is verified when **any attempt** of a `deploy-staging.yml` run on `main`
for that exact commit completed all four steps successfully:

- **Apply staging D1 migrations**
- **Deploy staging Worker**
- **Run staging HTTP gates**
- **Run Playwright smoke against staging**

A green attempt that skipped those steps (for example, without staging credentials) does not
count.

Verification is permanent once earned. A later attempt or run of the same commit cannot
withdraw it, whether that attempt is a re-run still in progress, a flaky smoke test, a broken
staging token, or an older commit replayed over a newer staging schema. Those failures
describe the staging environment, not the commit. A rule that let them withdraw verification
could let `migrate production` pass and `deploy production` refuse within one release.

The check runs twice, and both use the workflow's `GITHUB_TOKEN` with `actions: read`:

1. The `authorize` job runs `scripts/staging-verification.ts` before the `production`
   environment asks for reviewer approval.
2. `cloudflare-release.ts` repeats it immediately before `migrate production`,
   `deploy production`, and `import production`, and before any Wrangler call.

A dispatch always releases the head of `main`. Only a pushed head gets its own Deploy Staging
run, so when several commits land in one push, only the last one is verified. If Deploy
Staging is still running, wait for it.

If the head has no verified attempt (the run failed, a push skipped CI, or Actions had an
outage), start a new run on the head of `main`, wait for it to pass, then dispatch the
production workflow again:

```bash
gh workflow run deploy-staging.yml --ref main
```

Re-running the commit's own failed run also works. Don't re-run an older commit's run: it
would deploy that older Worker to staging.

To check a commit from a maintainer machine:

```bash
GITHUB_TOKEN="$(gh auth token)" pnpm tsx scripts/staging-verification.ts <commit-sha>
```

The bootstrap gate matters even after the first import (run 36800330629). The bootstrap
applies every migration at its commit to an empty production database, for example a
re-created one. The publication and submission workflows change production data, not schema
or code, so they are not gated on staging.

Until the token split, this is a process control, not a security boundary.

- **Narrowed:** the `staging` environment allows deployments only from `main`, so only
  workflows running from `main` can use the staging secrets.
- **Still open:** both environments still hold the account-wide Cloudflare token, so a
  workflow merged to `main` that uses `staging` could still reach production directly. That
  path requires a pull request and the five required checks of ruleset `main`, but no
  approving review.

Decision b (the per-environment token split, right after cutover) closes that path. Under
decision d, the `staging` environment's restriction moves from `main` to the `staging`
branch.
