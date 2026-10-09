# Deploy runbook

How best.serp.co reaches staging and production: the environments, the protected workflows and
their guards, a production release, recovery, and what to check after a deploy. Every push to
`staging` deploys staging; every push to `main` releases production, which serves best.serp.co
from its Worker since the [production cutover](./PRODUCTION_CUTOVER.md).

## Environments

| | Staging | Production |
|---|---|---|
| Worker and D1 database | `best-serp-co-staging` | `best-serp-co-production` |
| Origin | https://best-serp-co-staging.serpcompany.workers.dev | https://best.serp.co (Worker Custom Domain on the `serp.co` zone) |
| Platform host | the origin; every `*.workers.dev` response carries `X-Robots-Tag: noindex, nofollow` | https://best-serp-co-production.serpcompany.workers.dev, which 308s to best.serp.co except for smoke-test requests |
| Branch | `staging`, the base branch (pull requests squash-merge; hotfix merge-backs use a merge commit) | `main` (fast-forward promotions of `staging`, and `hotfix-*` pull requests) |
| GitHub environment | `staging` (`staging` branch only, no reviewers) | `production` (`main` only, required reviewers) |
| Email ([useSend](./EMAIL.md)) | `mail.serp.co`, `[staging]` prefix, allowlist | `mail.serp.co` |

Keep `workers_dev: true` on both: CI gates production through its platform host with the
`x-best-serp-co-smoke-test` header, then on best.serp.co without it
([Environments and hosts](./ARCHITECTURE.md#environments-and-hosts)). The identities live in
`env.staging` / `env.production` of `apps/web/wrangler.jsonc` and in `scripts/project.ts` (IDs
are not secrets); `scripts/cloudflare-release.ts` refuses to run when the two disagree. The
Cloudflare token and the GitHub environments that hold it are in
[Deploy credentials](./DEPLOY_CREDENTIALS.md).

## Database commands, promotion, and staging before production

[Release guards](./RELEASE_GUARDS.md) lists every `db:*` command with its target, defines
the `staging` → `main` promotion and the hotfix path, and explains the staging-before-production
check (the released commit must carry a tree Deploy Staging verified) that gates production
migrations, imports, and Worker deploys.

## Workflows

| Workflow | Trigger | Environment | Typed confirmation | Does |
|---|---|---|---|---|
| `web.yml` (`deploy-staging`) | push to `staging` after `check`, `e2e` and `tip`, manual from `staging` | `staging` | none | build → tip guard → D1 bookmark → migrations → deploy → HTTP gates → Playwright smoke |
| `deploy-production.yml` | push to `main`, manual | `production` | dispatch: `deploy-best.serp.co-production` (or `hotfix-…`) | Staging verification → `pnpm harness:fast` → build → `plan-release` → (pending migrations: bookmark → migrate) → deploy → HTTP gates |
| `bootstrap-production-d1.yml` | manual, `main` | `production` | `bootstrap-best.serp.co-production` | Staging verification → D1 bookmark → initial catalog import into an empty production D1 → parity verification ([bootstrap](./PRODUCTION_BOOTSTRAP.md)) |
| `publish-d1.yml`, `publish-d1-staging.yml` | manual, `main` / `staging` | `production` / `staging` | `publish-best.serp.co-<env>` | D1 bookmark → apply one reviewed manifest, staging first |
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
   `deploy`) outside the workflow, branch, events, and environment that own it, at anything but
   a clean `GITHUB_SHA`, or on a dispatch without the confirmation in `RELEASE_CONFIRM` (its
   header has the full rule). Production ones also require the verified Deploy Staging run (a
   hotfix dispatch of a merged `hotfix-*` pull request may only `deploy` without it) and a
   `main` that still points at the release. The publisher and `media-upload.ts` apply their
   own guards.
4. `plan-release` refuses a database with migrations this commit lacks. `deploy` first proves
   that every `apps/web/drizzle` migration is applied and that a catalog publication exists.

The HTTP gates: [Environments and hosts](./ARCHITECTURE.md#environments-and-hosts).

Concurrency sits on the privileged job, after its guards. Every production D1 or Worker job
shares one group, staging's deploy and publication share another, media health and the media
uploads have their own, and none cancels a running job. The staging group queues
(`queue: max`), so a staging deploy and a staging publication never cancel each other. A run
refused by `authorize` or skipped by a branch `if` never joins a group.

The staging deploy is a job of `web.yml` and `needs:` its `check`, `e2e` and `tip`, so it builds
the commit once, deploys only after both checks pass, and only while the commit is the `staging`
head; its in-job tip guard skips a commit `staging` moved past while it waited ([CI](./CI.md)).
Deploy Production runs `pnpm harness:fast` in its own job: it releases only a tree the staging
deploy verified, which is the stronger gate, and a `workflow_run` job would receive the default
branch head as `GITHUB_SHA` rather than the released commit.

## Production release

1. Wait until Deploy Staging is green for the `staging` head. If the head has no verified
   attempt, start one with `gh workflow run web.yml --ref staging`
   ([Release guards](./RELEASE_GUARDS.md#staging-before-production)).
2. The owner runs `pnpm release:promote` at a terminal and types the short SHA it shows. It
   fast-forwards `main` to that verified commit ([Promotion](./RELEASE_GUARDS.md#promotion)).
3. The push to `main` runs Deploy Production: the staging check finds that commit's own run,
   the `production` reviewers approve, and the release bookmarks and migrates D1 first only
   when `apps/web/drizzle` migrations are pending.

Migrations are forward-only and applied before the new Worker deploys, so each must stay
compatible with the live Worker while it applies. A `deploy-best.serp.co-production` dispatch
re-runs a release of the `main` head; a release is refused once `main` has moved on, so reject
one you won't ship instead of leaving it waiting. Hotfixes follow
[Release guards](./RELEASE_GUARDS.md#hotfixes).

## Bookmarks and recovery

- No workflow exports D1: this repository is public, so an Actions artifact would expose
  sessions, OAuth tokens, and emails. Before each D1 change, `cloudflare-release.ts
  bookmark <env>` writes the Time Travel bookmark and its restore command to the run summary,
  and fails the job, before any change, if it cannot.
- Restore (the owner only; every later write is lost) from the first attempt's bookmark
  ([D1 recovery](./D1_RECOVERY.md#restore-a-workflow-bookmark)). Time Travel keeps 30 days.
  After a bad migration, roll the Worker back first and don't redeploy `main` until a fix is
  promoted ([Undo a bad migration](./D1_RECOVERY.md#undo-a-bad-migration)).
- Worker rollback: dashboard → Workers → `best-serp-co-production` → Deployments → Rollback,
  or `wrangler rollback --env production`. A rollback does not undo a migration.
- Emergency deploy (the owner only, when the workflows cannot run): `pnpm deploy:staging` or
  `pnpm deploy:production` builds the Worker and runs `opennextjs-cloudflare deploy --env`. It
  skips every release guard: the staging verification, the authorization, and the migration
  check. Use it only when `pnpm db:migrations:list:<env>` shows nothing pending (migrations
  apply only in the workflows); otherwise roll back. Export `NEXT_PUBLIC_SENTRY_DSN` and
  `NEXT_PUBLIC_SENTRY_RELEASE` (the commit) first, or the build ships with Sentry off. Agents
  never run it.

## After a deploy

When a Deploy Production run logs `best.serp.co check skipped` (zone protection, not the
Worker, answered best.serp.co), check best.serp.co by hand from a maintainer machine:

```bash
pnpm tsx scripts/d1-preview-http-gates.ts public https://best.serp.co
curl -sI https://best.serp.co/ | grep -i -e x-worker-version -e x-site-environment
```

The first runs the same best.serp.co checks without skipping anything; the second must show
`x-site-environment: production` and the version the run deployed (what each check compares:
[Environments and hosts](./ARCHITECTURE.md#environments-and-hosts)).

`wrangler.jsonc` points `main` at `apps/web/worker.ts`, which wraps the generated
`.open-next/worker.js`, so every deploy ships the edge HTML cache with the Worker
([Caching](./CACHING.md)). Confirm it after a deploy:

```bash
curl -sI https://best-serp-co-staging.serpcompany.workers.dev/about/ | grep -i x-edge-cache  # MISS
curl -sI https://best-serp-co-staging.serpcompany.workers.dev/about/ | grep -i x-edge-cache  # HIT
```

A deploy starts with a cold HTML cache (the Worker version is part of every key): the first
request per page and data center renders, later ones are served from the cache. A
publication or approval reaches cached pages within about a minute; nothing is purged.
Caching needs nothing created per environment (no KV namespace, Durable Object, or queue); the
media buckets are in [Listing media](./MEDIA.md).

Production database or Worker operations require explicit maintainer confirmation;
a passing local harness never grants deployment authority.
