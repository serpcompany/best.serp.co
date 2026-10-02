# Deploy runbook

Status (serpcompany/best.serp.co#34):

- **Staging** is live at https://best-serp-co-staging.serpcompany.workers.dev (D1
  `best-serp-co-staging`, catalog imported and verified against the parity report). Every
  `*.workers.dev` response carries `X-Robots-Tag: noindex, nofollow`. It was first deployed
  by hand with `wrangler login`; from now on `deploy-staging.yml` deploys every push to `main`.
- **Production** D1 `best-serp-co-production` is bootstrapped and verified (run
  36800330629), and the production Worker is deployed (run 36802748585) at its noindex
  review URL. DNS has not moved.
- **best.serp.co** is still served by GitHub Pages from the `legacy-static` branch, whose
  deploy workflow runs on pushes to that branch.

## Environments

| | Staging | Production |
|---|---|---|
| Worker | `best-serp-co-staging` (workers.dev) | `best-serp-co-production` (workers.dev review URL until cutover) |
| D1 | `best-serp-co-staging` `8e6b67e5-9c58-4fa9-aca1-25b0020c0833` | `best-serp-co-production` `404ec437-53a2-4fbc-8b5f-b5e69065708e` |
| Origin | https://best-serp-co-staging.serpcompany.workers.dev | https://best.serp.co (Worker Custom Domain on `serp.co`, at cutover) |
| Review origin (pre-cutover) | — | https://best-serp-co-production.serpcompany.workers.dev (`workers_dev: true`; `*.workers.dev` responses are `noindex`). Production HTTP gates run here until best.serp.co stops returning `server: GitHub.com`. After cutover, set `workers_dev: false` (and `project.remote.production.workersDev`) to retire it. |
| GitHub environment | `staging` | `production` (required reviewers, `main` only) |

The identities live in `env.staging` / `env.production` of `apps/web/wrangler.jsonc` and in
`scripts/project.ts` (IDs are not secrets). `scripts/cloudflare-release.ts` refuses to run
when the two disagree. Cloudflare account: `SERP`, `cec5f04e1d18bcc65f2be0aefb04f059`.

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

Today this is a process control, not a security boundary. Both GitHub environments hold an
account-wide Cloudflare token, and the `staging` environment has no deployment-branch
policy or reviewers. A workflow on any branch that uses the `staging` environment could
therefore reach production directly. Restricting the `staging` environment's branches and
splitting the token (#42 decisions b and d) close that gap.

## Setup

### Cloudflare API token

Create an **account-owned** token in the SERP account dashboard:
https://dash.cloudflare.com/cec5f04e1d18bcc65f2be0aefb04f059/api-tokens (Manage Account →
Account API Tokens → Create Token → Custom token). Do not use the user profile page
(`dash.cloudflare.com/profile/api-tokens`). Scope it to the SERP account only, with these
account permissions:

| Account permission | Used by |
|---|---|
| D1 → Edit | `wrangler d1 migrations apply`, `d1 execute` (bootstrap import, read-only checks), `d1 export` backups, and the D1 query API used by the publisher, approver, and notifier |
| Workers Scripts → Edit | `opennextjs-cloudflare deploy`: Worker upload, static assets, the workers.dev setting, observability |
| Account Settings → Read | Wrangler account lookups during deploy |

No zone permission is needed while the Custom Domain is attached in the dashboard. Add
Zone → Workers Routes → Edit (zone `serp.co`) only if routes or the Custom Domain move into
`wrangler.jsonc`. If an R2 or KV incremental cache is added to `apps/web/open-next.config.ts`,
add Workers R2 Storage → Edit or Workers KV Storage → Edit, because the deploy populates it.

Cloudflare's current Workers roles map Workers Scripts → Edit to Workers **Editor**, which
cannot create a Worker. The first production deploy created `best-serp-co-production` with
an account-wide token. Both Workers now exist, so per-Worker Editor scopes are enough. The
owner approved splitting the token right after cutover (serpcompany/best.serp.co#42,
decision b; see [GitHub environments](#github-environments)).

### GitHub environments

The `staging` and `production` environments exist:

- `production` requires reviewer approval and allows deployments only from `main`.
- `staging` has no reviewers and no deployment-branch policy yet.

Each holds two environment secrets:

- `CLOUDFLARE_ACCOUNT_ID`: `cec5f04e1d18bcc65f2be0aefb04f059`
- `CLOUDFLARE_API_TOKEN`: today, **both environments hold the account-wide token**
  described above (#34), with Edit on every Worker and D1 database in the SERP account. A leak from
  either environment therefore reaches staging and production alike.

The planned fix is #42 decision b, scheduled right after cutover. It gives each environment
its own token, scoped to that environment's Worker and D1 database, plus a D1-only token for
`production-notifier`. Each new token is proven in its workflow before the account-wide
token is revoked. Until then, separate secrets do not limit the blast radius.

Until the `staging` secrets exist, `deploy-staging.yml` finishes green with a "Staging deploy
skipped" notice. After they exist, the next push to `main` deploys staging.

### Submission notifier (after the production bootstrap)

The scheduled notifier cannot use `production`, because a schedule cannot pass reviewer
approval. When production accepts submissions:

1. Create the environment `production-notifier`: deployment branches `main` only, no
   required reviewers. Add `CLOUDFLARE_ACCOUNT_ID` and a `CLOUDFLARE_API_TOKEN` that has only
   Account → D1 → Edit.
2. Add the **repository** variable `SUBMISSION_REVIEWER_GITHUB_LOGIN` (Settings → Secrets
   and variables → Actions → Variables) set to the reviewer's GitHub login. It must be a
   repository variable: the job-level `if` that switches the notifier on is evaluated before
   environment variables load. Until it is set, every scheduled run is skipped at no cost.

## Workflows

| Workflow | Trigger | Environment | Typed confirmation | Does |
|---|---|---|---|---|
| `deploy-staging.yml` | push to `main`, manual | `staging` | none | `pnpm harness:fast` → Worker build → staging D1 migrations → deploy → HTTP gates → Playwright smoke |
| `deploy-production.yml` | manual, `main` | `production` | `deploy-best.serp.co-production` | Staging verification → `pnpm harness:fast` → Worker build → (database-and-worker: D1 backup → migrations) → deploy → HTTP gates |
| `bootstrap-production-d1.yml` | manual, `main` | `production` | `bootstrap-best.serp.co-production` | Staging verification → initial catalog import into an empty production D1 → parity verification |
| `publish-d1.yml` | manual, `main` | `production` | `publish-best.serp.co-production` | D1 backup → apply one `d1/publications/*.yaml` manifest |
| `approve-d1-submission.yml` | manual, `main` | `production` | `approve-best.serp.co-submission-production` | D1 backup → approve or reject one submission → close its review issue |
| `notify-d1-submissions.yml` | every 15 minutes, manual | `production-notifier` | none | Open an assigned review issue per badge-verified submission |

Guards, in order:

1. An `authorize` job with no secrets checks `main` and the typed confirmation (and the
   manifest path or submission UUID), so a mistyped dispatch never requests reviewer approval.
   Deploy Production and Bootstrap Production D1 also require Deploy Staging to have verified
   the commit (see [Staging before production](#staging-before-production)).
2. The GitHub `production` environment requires reviewer approval.
3. `scripts/cloudflare-release.ts` refuses every mutating command (`backup`, `migrate`,
   `import`, `deploy`) unless it runs in the workflow file that owns it, against that
   workflow's environment, on `main` at a clean `GITHUB_SHA`, with the confirmation in
   `RELEASE_CONFIRM`. Production `migrate`, `deploy`, and `import` also require the
   verified Deploy Staging run. `d1-remote-publisher.ts`, `d1-submission-approver.ts`, and
   `d1-submission-notifier.ts` apply their own workflow and confirmation guards.
4. `deploy` first proves that every `d1/drizzle` migration is applied, that no unknown
   migration is present, and that a catalog publication exists.

The production workflows share the concurrency group `best-serp-co-production` and never
cancel a running job. GitHub keeps only the newest pending run in a group, so re-dispatch a
queued run that shows as cancelled. The notifier has its own group.

Staging runs `pnpm harness:fast` in its own job rather than waiting on Main Validation
through `workflow_run`. A `workflow_run` job receives the default branch head as
`GITHUB_SHA`, not the validated commit. That would break the release guard's `HEAD ==
GITHUB_SHA` check, and a slow validation of an older commit could deploy after a newer one.
PR Review already gates every merge, and Main Validation re-runs the full loop on the same
commit in parallel.

## Production release

### First release (Phase 4b)

1. Run **Bootstrap Production D1** with `bootstrap-best.serp.co-production`. `import`
   refuses a database that holds any publication, catalog, or `migration_runs` row before
   changing anything. It then applies the migrations, decompresses
   `d1/artifacts/best-serp-co-v1.sql.br`, refuses it unless its sha256 equals the parity
   report's `artifact.sqlChecksum`, and imports it in one D1 execution. If the execution
   fails, D1 rolls it back and the run can be repeated. A repeat after success is a no-op.
   `verify-import` then compares all 16 application tables with an in-memory bootstrap of the
   same SQL and checks the publication checksum (`669f264f…0af5a`), version, and every count
   in the report.
2. Run **Deploy Production** with `deploy-best.serp.co-production` and `worker-only` (the
   bootstrap already applied the migrations). The HTTP gates are skipped with a notice while
   GitHub Pages still serves best.serp.co.
3. Continue with the cutover checklist below, then re-run **Deploy Production**
   (`worker-only`) so the HTTP gates run against https://best.serp.co.

### Routine releases

- Merging to `main` deploys staging. Deploy Production refuses the commit until that
  Deploy Staging run has succeeded.
- Use `database-and-worker` when the release adds a `d1/drizzle` migration. `worker-only`
  refuses a database with pending migrations and says so.
- Migrations are forward-only and applied before the new Worker deploys, so each migration
  must stay compatible with the Worker that is live while it applies.

### Backups and recovery

- `backup` exports the whole production D1 (including submissions) to an Actions artifact
  named `best-serp-co-production-d1-pre-{deploy,publication,review}-<run id>`, kept 30 days
  and downloadable by anyone with read access to this repository. Running an export blocks
  other queries to that database until it finishes.
- Point-in-time recovery: D1 Time Travel, for example `wrangler d1 time-travel restore
  best-serp-co-production --env production --timestamp <before the run>`, run by a
  maintainer after reviewer agreement.
- Worker rollback: Cloudflare dashboard → Workers → `best-serp-co-production` →
  Deployments → Rollback, or `wrangler rollback --env production`. A rollback does not undo
  a migration.

## Rehearsals and read-only checks

Rehearse the exact bootstrap path against an isolated local D1 (no Cloudflare access):

```bash
dir="$(mktemp -d)"
pnpm tsx scripts/cloudflare-release.ts import production --rehearse "$dir"
pnpm tsx scripts/cloudflare-release.ts verify-import production --rehearse "$dir"
pnpm tsx scripts/cloudflare-release.ts check-database production --rehearse "$dir"
```

`list-migrations <env>`, `check-database <env>`, and `verify-import <env>` are read-only and
may run against a remote database from a maintainer machine after `wrangler login`. `verify-import` issues about 90
paged reads and takes about a minute and a half. Every other command refuses to run outside
its protected workflow.

Evidence from 2026-09-30: the local production rehearsal and a read-only `verify-import`
against staging both produced the exact 16-table snapshot `69a7bae9…e477` (3,422 listings,
141 categories, 18,096 rows). The staging HTTP gates and the 17-test Playwright smoke suite
passed against the staging Worker.

## Caching after a deploy

`wrangler.jsonc` points `main` at `apps/web/worker.ts`, which wraps the generated
`.open-next/worker.js`, so `opennextjs-cloudflare deploy` (and therefore
`deploy-staging.yml` / `deploy-production.yml`) ships the edge HTML cache with the Worker
(see [Architecture](./ARCHITECTURE.md#caching)). Confirm it after a deploy:

```bash
curl -sI https://best-serp-co-staging.serpcompany.workers.dev/about/ | grep -i x-edge-cache  # MISS
curl -sI https://best-serp-co-staging.serpcompany.workers.dev/about/ | grep -i x-edge-cache  # HIT
```

A deploy starts with a cold HTML cache (the Worker version is part of every key): the first
request per page and data center renders, later ones are served from the cache. A
publication or approval reaches cached pages within about a minute; nothing is purged.

| Resource | Staging | Production |
|---|---|---|
| Workers Cache API (edge HTML and data cache) | built in, nothing to create | built in, nothing to create |
| `version_metadata` binding `CF_VERSION_METADATA` | declared in `wrangler.jsonc` | declared in `wrangler.jsonc` |

Caching needs no R2 bucket, KV namespace, Durable Object, or queue, and no API token
permission beyond the deploy token above.

## Cutover checklist

1. Staging passes `pnpm migration:compare -- <staging-origin> --sample 60` with zero
   differences, a full sitemap crawl with zero non-200s, and the smoke suite.
2. Stop `json-directory-template` from deploying serp.co (its deploy would overwrite
   this repository's `main`). Done in serpcompany/json-directory-template#154.
3. Bootstrap and deploy production as described in [First release](#first-release-phase-4b).
4. Attach the Custom Domain `best.serp.co` to the production Worker (replaces the
   GitHub Pages CNAME), confirm `curl -I https://best.serp.co` no longer shows
   `server: GitHub.com`, re-run **Deploy Production** (`worker-only`) for the HTTP gates,
   and submit `sitemap-index.xml` in Search Console.
5. Set up the submission notifier and re-enable the `submit-gsc-sitemaps.yml` schedule.
6. Disable GitHub Pages and delete the `legacy-static` branch.
7. Remove `apps/serp.co` and `sites/serp.co` from `json-directory-template`.

Production database or Worker operations require explicit maintainer confirmation;
a passing local harness never grants deployment authority.
