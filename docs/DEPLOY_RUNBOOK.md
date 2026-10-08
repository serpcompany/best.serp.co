# Deploy runbook

Status (serpcompany/best.serp.co#34):

- **Staging** is live at https://best-serp-co-staging.serpcompany.workers.dev (D1
  `best-serp-co-staging`, catalog imported and verified against the parity report). Every
  `*.workers.dev` response carries `X-Robots-Tag: noindex, nofollow`. It was first deployed
  by hand with `wrangler login`; `deploy-staging.yml` now deploys every push to `staging`.
- **Production** D1 `best-serp-co-production` is bootstrapped and verified (run
  36800330629), and the production Worker is deployed (run 36802748585) at its noindex
  review URL. DNS has not moved. `deploy-production.yml` releases every promotion to `main`.
- **best.serp.co** is still served by GitHub Pages from the `legacy-static` branch, whose
  deploy workflow runs on pushes to that branch.

## Environments

| | Staging | Production |
|---|---|---|
| Worker | `best-serp-co-staging` (workers.dev) | `best-serp-co-production` (workers.dev review URL until cutover) |
| D1 | `best-serp-co-staging` `8e6b67e5-9c58-4fa9-aca1-25b0020c0833` | `best-serp-co-production` `404ec437-53a2-4fbc-8b5f-b5e69065708e` |
| Origin | https://best-serp-co-staging.serpcompany.workers.dev | https://best.serp.co (Worker Custom Domain on `serp.co`, at cutover) |
| Review origin (pre-cutover) | — | https://best-serp-co-production.serpcompany.workers.dev (`workers_dev: true`, noindex). The production HTTP gates run here with the smoke-test header and, after cutover, on best.serp.co, where they skip only zone protection (`cf-mitigated`, or a 403 or 429 without Worker headers) and GitHub Pages ([Environments and hosts](./ARCHITECTURE.md#environments-and-hosts)). It stays after cutover: `CANONICAL_HOST_REDIRECT` flips to `on` and it 308s to best.serp.co except for smoke-test requests (#42 decision e). |
| Branch | `staging` (the base branch; PRs squash-merge here, hotfix merge-backs use a merge commit) | `main` (fast-forward promotions of `staging`, and `hotfix-*` PRs) |
| GitHub environment | `staging` (`staging` branch only, no reviewers) | `production` (required reviewers, `main` only) |
| Email ([useSend](./EMAIL.md)) | `mail.serp.co`, `[staging]` prefix, allowlist | `mail.serp.co` |

The identities live in `env.staging` / `env.production` of `apps/web/wrangler.jsonc` and in
`scripts/project.ts` (IDs are not secrets). `scripts/cloudflare-release.ts` refuses to run
when the two disagree. Cloudflare account: `SERP`, `cec5f04e1d18bcc65f2be0aefb04f059`.

## Database commands, promotion, and staging before production

[Release guards](./RELEASE_GUARDS.md) lists every `db:*` command with its target, defines
the `staging` → `main` promotion and the hotfix path, and explains the staging-before-production
check (the released commit must carry a tree Deploy Staging verified) that gates production
migrations, imports, and Worker deploys. Re-verify the `staging` head with
`gh workflow run deploy-staging.yml --ref staging`.

## Setup

### Cloudflare API token

Create an **account-owned** token in the SERP account dashboard:
https://dash.cloudflare.com/cec5f04e1d18bcc65f2be0aefb04f059/api-tokens (Manage Account →
Account API Tokens → Create Token → Custom token). Do not use the user profile page
(`dash.cloudflare.com/profile/api-tokens`). Scope it to the SERP account only, with these
account permissions:

| Account permission | Used by |
|---|---|
| D1 → Edit | `wrangler d1 migrations apply`, `d1 execute` (bootstrap import, read-only checks), `d1 time-travel info` bookmarks, and the D1 query API used by the publisher |
| Workers Scripts → Edit | `opennextjs-cloudflare deploy`: Worker upload, static assets, the workers.dev setting, observability |
| Account Settings → Read | Wrangler account lookups during deploy |
| Workers R2 Storage → Edit | the `MEDIA` bucket binding and listing media uploads (#95) |

No zone permission is needed while the Custom Domain is attached in the dashboard. Add Zone →
Workers Routes → Edit (zone `serp.co`) only if routes or the Custom Domain move to `wrangler.jsonc`.

Cloudflare's current Workers roles map Workers Scripts → Edit to Workers **Editor**, which
cannot create a Worker. The first production deploy created `best-serp-co-production` with
an account-wide token. Both Workers now exist, so per-Worker Editor scopes are enough. The
owner approved splitting the token right after cutover (serpcompany/best.serp.co#42,
decision b; see [GitHub environments](#github-environments)).

### GitHub environments

The `staging` and `production` environments exist:

- `production` requires reviewer approval and allows deployments only from `main`.
- `staging` allows deployments only from the `staging` branch and has no reviewers.

Each holds two environment secrets:

- `CLOUDFLARE_ACCOUNT_ID`: `cec5f04e1d18bcc65f2be0aefb04f059`
- `CLOUDFLARE_API_TOKEN`: today, **both environments hold the account-wide token**
  described above (#34), with Edit on every Worker, D1 database, and R2 bucket (serp.co's `cdn`
  too). A leak from either environment therefore reaches staging and production alike.

The planned fix is #42 decision b, scheduled right after cutover. It gives each environment
its own token, scoped to its Worker, D1 database, and R2 bucket (production's also reads
`cdn-staging`, the upload's copy source), each proven in its workflow before the
account-wide token goes. Until then, a leak reaches both.

Until the `staging` secrets exist, `deploy-staging.yml` finishes green with a "Staging deploy
skipped" notice. After they exist, the next push to `staging` deploys staging. The
`BETTER_AUTH_SECRET` secret and the `/admin` Access app: [Accounts](./ACCOUNTS.md).
Error reporting (Sentry) and analytics (GTM, Cloudflare Web Analytics):
[Telemetry](./TELEMETRY.md).

## Workflows

| Workflow | Trigger | Environment | Typed confirmation | Does |
|---|---|---|---|---|
| `deploy-staging.yml` | push to `staging`, manual from `staging` | `staging` | none | `pnpm harness:fast` → build → D1 bookmark → migrations → deploy → HTTP gates → Playwright smoke |
| `deploy-production.yml` | push to `main`, manual | `production` | dispatch: `deploy-best.serp.co-production` (or `hotfix-…`) | Staging verification → `pnpm harness:fast` → build → `plan-release` → (pending migrations: bookmark → migrate) → deploy → HTTP gates |
| `bootstrap-production-d1.yml` | manual, `main` | `production` | `bootstrap-best.serp.co-production` | Staging verification → D1 bookmark → initial catalog import into an empty production D1 → parity verification |
| `publish-d1.yml`, `publish-d1-staging.yml` (#95) | manual, `main` / `staging` | `production` / `staging` | `publish-best.serp.co-<env>` | D1 bookmark → apply one reviewed manifest, staging first |
| `upload-media.yml`, `upload-media-staging.yml` | manual, `main` / `staging` | `production` / `staging` | `upload-media-best.serp.co-<env>` | Upload one reviewed `d1/media/` plan to R2, no D1 change ([media](./MEDIA.md)) |
| `media-health.yml` | weekly | `production-media-health` | none | [Health](./MEDIA_HEALTH.md) |

Guards, in order:

1. An `authorize` job with no secrets checks the workflow's branch and, on a dispatch, the typed
   confirmation (and the manifest or plan path), so a mistyped dispatch never
   requests reviewer approval. Deploy Production and Bootstrap Production D1 also require
   Deploy Staging to have verified the commit's tree (see
   [Release guards](./RELEASE_GUARDS.md#staging-before-production)).
2. The GitHub `production` environment requires reviewer approval, for pushes and dispatches.
3. `scripts/cloudflare-release.ts` refuses every mutating command (`migrate`, `import`,
   `deploy`) unless it runs in the workflow file that owns it, on that workflow's
   branch (`staging` or `main`) and events, against its environment, at a clean `GITHUB_SHA`,
   with the confirmation in `RELEASE_CONFIRM` on a dispatch. Production `migrate`, `deploy`,
   and `import` also require the verified Deploy Staging run (a hotfix dispatch of a merged
   `hotfix-*` PR may only `deploy` without it) and a `main` that still points at the release.
   The publisher and `media-upload.ts` apply their own guards.
4. `plan-release` refuses a database with migrations this commit lacks. `deploy` first proves
   that every `d1/drizzle` migration is applied and that a catalog publication exists.

The HTTP gates: [Environments and hosts](./ARCHITECTURE.md#environments-and-hosts).

Concurrency sits on the privileged job, after its guards: production jobs share
`deploy-best-serp-co-production`, staging uses `deploy-best-serp-co-staging`, media health and
media uploads their own groups, and none cancels a running job. A run refused by `authorize`
or skipped by a branch `if` never joins a group, so it cannot replace a valid queued run.

Each deploy runs `pnpm harness:fast` in its own job rather than waiting on Main Validation
through `workflow_run`. A `workflow_run` job receives the default branch head as
`GITHUB_SHA`, not the validated commit. That would break the release guard's `HEAD ==
GITHUB_SHA` check, and a slow validation of an older commit could deploy after a newer one.
PR Review already gates every merge, and Main Validation re-runs the full loop on the same
`staging` or `main` commit in parallel.

## Production release

### First release (Phase 4b)

1. Run **Bootstrap Production D1** with `bootstrap-best.serp.co-production`. `import`
   refuses a database that holds any publication, catalog, or `migration_runs` row before
   changing anything. It then applies the migrations, decompresses
   `d1/artifacts/best-serp-co-v1.sql.br`, refuses it unless its sha256 equals the parity
   report's `artifact.sqlChecksum`, and imports it in one D1 execution. If the execution
   fails, D1 rolls it back and the run can be repeated. A repeat after success is a no-op.
   `verify-import` then requires the runtime tables (accounts, limits, email ledger) to be
   empty, compares every other table with an in-memory bootstrap of the same SQL, and checks
   the publication checksum (`669f264f…0af5a`), version, and every count in the report.
2. Run **Deploy Production** (the bootstrap already applied the migrations, so it plans
   `worker-only`). While GitHub Pages still serves best.serp.co, the HTTP gates run against
   the noindex review origin instead.
3. Continue with the cutover checklist below, then re-run **Deploy Production** so the HTTP
   gates run in production mode: through the workers.dev host, then on best.serp.co.

### Routine releases (promotion)

1. Wait until Deploy Staging is green for the `staging` head.
2. The owner runs `pnpm release:promote` at a terminal and types the short SHA it shows. It
   fast-forwards `main` to that verified commit ([Promotion](./RELEASE_GUARDS.md#promotion)).
3. The push to `main` runs Deploy Production: the staging check finds that commit's own run,
   the `production` reviewers approve, and the release bookmarks and migrates D1 first only
   when `d1/drizzle` migrations are pending.

Migrations are forward-only and applied before the new Worker deploys, so each must stay
compatible with the live Worker while it applies. A `deploy-best.serp.co-production` dispatch
re-runs a release of the `main` head; a release is refused once `main` has moved on, so reject
one you won't ship instead of leaving it waiting. Hotfixes follow
[Release guards](./RELEASE_GUARDS.md#hotfixes).

### Bookmarks and recovery

- No workflow exports D1: this repository is public, so an Actions artifact would expose
  sessions, OAuth tokens, and emails (#99). Before each D1 change, `cloudflare-release.ts
  bookmark <env>` writes the Time Travel bookmark and its restore command to the run summary,
  and fails the job, before any change, if it cannot.
- Restore (the owner only; every later write is lost) from the first attempt's bookmark. After a
  bad migration, roll the Worker back first and don't redeploy `main` until a fix is promoted
  ([D1 recovery](./D1_RECOVERY.md#restore-a-workflow-bookmark)). Time Travel keeps 30 days.
- Worker rollback: dashboard → Workers → `best-serp-co-production` → Deployments → Rollback,
  or `wrangler rollback --env production`. A rollback does not undo a migration.

## Rehearsals and read-only checks

Rehearse the exact bootstrap path against an isolated local D1 (no Cloudflare access):

```bash
dir="$(mktemp -d)"
pnpm tsx scripts/cloudflare-release.ts import production --rehearse "$dir"
pnpm tsx scripts/cloudflare-release.ts verify-import production --rehearse "$dir"
pnpm tsx scripts/cloudflare-release.ts check-database production --rehearse "$dir"
```

`list-migrations <env>`, `check-database <env>`, and `verify-import <env>` are read-only and
may run against a remote database from a maintainer machine after `wrangler login`.
`verify-import` issues about 90 paged reads and takes about a minute and a half. Every other
command refuses to run outside its protected workflow.

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
| Workers Cache API (edge HTML, data) | built in, nothing to create | built in, nothing to create |
| `version_metadata` binding `CF_VERSION_METADATA` | in `wrangler.jsonc` | in `wrangler.jsonc` |
| R2 `MEDIA` (#95) | `cdn-staging` on `cdn-staging.serp.co` | `cdn` on `cdn.serp.co` |

Caching needs no KV namespace, Durable Object, or queue. Media: [Listing media](./MEDIA.md).

## Cutover checklist

1. Staging passes `pnpm migration:compare -- <staging-origin> --sample 60` with zero
   differences, a full sitemap crawl with zero non-200s, and the smoke suite.
2. Stop `json-directory-template` from deploying serp.co (its deploy would overwrite
   this repository's `main`). Done in serpcompany/json-directory-template#154.
3. Bootstrap and deploy production as described in [First release](#first-release-phase-4b).
4. Attach the Custom Domain `best.serp.co` to the production Worker (replaces the
   GitHub Pages CNAME), confirm `curl -I https://best.serp.co` no longer shows
   `server: GitHub.com`, and re-run **Deploy Production** for the HTTP gates. Then check
   the custom domain **by hand** from a maintainer machine, a manual cutover step (and after
   any run that logged `best.serp.co check skipped`; what each check compares is in
   [Environments and hosts](./ARCHITECTURE.md#environments-and-hosts)):

   ```bash
   pnpm tsx scripts/d1-preview-http-gates.ts public https://best.serp.co
   curl -sI https://best.serp.co/ | grep -i -e x-worker-version -e x-site-environment
   ```

   If either fails, roll the Custom Domain back to GitHub Pages before investigating. Then
   submit `sitemap-index.xml` in Search Console.
5. Only after step 4, switch the platform host to the canonical host. Merge a reviewed PR
   into `staging` that sets `env.production.vars.CANONICAL_HOST_REDIRECT` to `"on"` in
   `apps/web/wrangler.jsonc`, wait for Deploy Staging to go green, then promote it
   (`pnpm release:promote`, [Routine releases](#routine-releases-promotion)).
   That push runs Deploy Production, which releases it after the owner's approval; its gates
   then also require the workers.dev host to answer one 308 to best.serp.co. Do not dispatch
   Deploy Production before the promotion is pushed: it would release the `main` head with
   the switch still `off` and never check the 308. Keep `workers_dev: true`; CI reaches the
   Worker there with the `x-best-serp-co-smoke-test` header. A flip before step 4 is live as
   soon as the deploy finishes (the review URL sends every visitor to GitHub Pages); the gates
   fail only afterwards. Recover by rolling the Worker back (see
   [Bookmarks and recovery](#bookmarks-and-recovery)), then set the switch back to `"off"` with a
   `hotfix-*` PR into `main` ([Release guards](./RELEASE_GUARDS.md#hotfixes)) or a change
   merged into `staging` and promoted.
6. Submission review moves in-app (#52); `submit-gsc-sitemaps.yml` stays manual-only.
7. Disable GitHub Pages and delete the `legacy-static` branch (done 2026-10-05).
8. Remove only serp.co pieces from `json-directory-template`; it still serves other sites.

Production database or Worker operations require explicit maintainer confirmation;
a passing local harness never grants deployment authority.
