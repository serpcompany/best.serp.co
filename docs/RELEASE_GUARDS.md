# Database commands and release guards

How database commands name their targets, how changes move from `staging` to `main`, and how a
production release proves that staging verified the same source first. Environments,
workflows, and the release procedure itself are in the [deploy runbook](./DEPLOY_RUNBOOK.md).

## Database commands

Every database command names its target, as the database standard requires. There is no
ambiguous `db:migrate`.

| Command | Target | Does |
|---|---|---|
| `pnpm db:generate` | none | `drizzle-kit generate` into `apps/web/drizzle/` |
| `pnpm db:migrations:list:local` | local D1 | `wrangler d1 migrations list --local`: migrations not applied yet |
| `pnpm db:migrate:local` | local D1 | `wrangler d1 migrations apply --local` |
| `pnpm db:import:local`, `pnpm db:verify:local` | local D1 | Seed the reviewed initial catalog and prove exact parity |
| `pnpm db:publish:local -- <manifest>` | local D1 | Apply a `d1/publications/` manifest |
| `pnpm db:migrations:list:staging` | staging D1 | Read-only: applied, pending, and unknown migrations |
| `pnpm db:migrate:staging` | staging D1 | `cloudflare-release.ts migrate staging`; runs only in `web.yml`'s `deploy-staging` job on `staging` |
| `pnpm db:migrations:list:production` | production D1 | Read-only: applied, pending, and unknown migrations |
| `pnpm db:migrate:production` | production D1 | `cloudflare-release.ts migrate production`; runs only in `deploy-production.yml` on `main` when `plan-release` finds pending migrations, after Deploy Staging verified the commit's tree |
| `pnpm db:publish:staging` | staging D1 | Apply a reviewed manifest; runs only in `publish-d1-staging.yml` on `staging` |
| `pnpm db:publish:production` | production D1 | Apply a reviewed manifest; runs only in `publish-d1.yml` on `main` |
| `pnpm media:upload:<staging\|production>` | media bucket | Upload a reviewed `d1/media/` plan; runs only in `upload-media-staging.yml` on `staging` or `upload-media.yml` on `main` |
| `pnpm media:upload:dry-run -- <plan>` | none | Fetch and verify every object of a plan; writes nothing |
| `pnpm deploy:<env>` | Worker | Owner-only emergency deploy that skips every guard here ([runbook](./DEPLOY_RUNBOOK.md)) |

The remote `migrations:list` commands run `cloudflare-release.ts list-migrations <env>`, which
reads the ledger with `wrangler d1 execute --remote --env <env>` and a `SELECT`. They do not
call `wrangler d1 migrations list`, because Wrangler's list first runs
`CREATE TABLE IF NOT EXISTS` on the ledger table. They work from a maintainer machine after
`wrangler login`.

Every D1 binding in `apps/web/wrangler.jsonc` declares `migrations_dir: "drizzle"`
and `migrations_table: "d1_migrations"`. `pnpm worker:config:validate` and every
`cloudflare-release.ts` command refuse a binding that drifts.

## Promotion

The repository follows the serp git-workflow standard for repositories with Staging
(serpcompany/best.serp.co#42, decision d):

- **`staging` is the base branch.** Branch from it as `issue-<n>-<slug>` and open pull
  requests into it. The owner squash-merges them (the hotfix merge-back below is the one
  merge commit), and each push to `staging` runs Deploy Staging. Agents never merge.
- **`main` is production.** `staging` reaches it by a **fast-forward**: the owner runs
  `pnpm release:promote` (`scripts/release-promote.ts`, #171), so `main` receives exactly the
  squash commits staging verified, with no promotion pull request and no merge commit. The push
  needs the owner's bypass of `main`'s pull request and check rules, kept in a ruleset of their
  own so deletion and force pushes stay blocked for everyone (#171 owner step); any other change
  to `main` is a `hotfix-*` pull request. Each push to `main` runs Deploy Production, which
  waits for the reviewers.
- **Only the owner releases.** Agents never dispatch a production workflow, never type a
  production confirmation, and never approve a deployment.
- **CI catches mis-targeted pull requests.** Once `staging` exists, `web.yml`'s `check` fails
  a pull request into `main` unless its head is a `hotfix-*` branch of this
  repository (rulesets cannot restrict a head branch). It is an accident guard, not the
  control: a pull request runs its own copy of the check and could edit it. The control is
  the release-time tree check below.

`pnpm release:promote` fetches, then refuses unless `main` is an ancestor of `staging` (after a
hotfix, merge `main` back first; see Hotfixes), Deploy Staging verified the head of `staging`
(below), and the owner types its first 12 characters at a terminal. It pushes that exact
commit, never forced. Agents never run it.

## Staging before production

Deploy Production and Bootstrap Production D1 release only source that Deploy Staging has
verified on `staging`. Deploy Staging verified a commit when **any attempt** of a push or
dispatch run of `web.yml` on `staging` completed all four `deploy-staging` steps successfully:

- **Apply staging D1 migrations**
- **Deploy staging Worker**
- **Run staging HTTP gates**
- **Run Playwright smoke against staging**

A green attempt that skipped those steps (for example, without staging credentials) does not
count, and neither do runs on other branches or `pull_request` runs.

**The released commit must have the tree of a verified staging commit.**
`scripts/staging-verification.ts` reads the released commit's tree and accepts either:

- the commit itself, verified on `staging` (a fast-forward, or a dispatch of that commit); or
- a commit among the newest 100 Deploy Staging runs on `staging` whose head has the same tree
  as the released commit.

The tree is everything the release ships: source, migrations, configuration, and workflows. A
fast-forward promotion releases the verified commit itself. The tree rule covers a release
commit that never ran on staging, such as the merge commits of the pull-request promotions
before #171: its tree equals a verified `staging` head's tree only if `main` had nothing that
`staging` lacked, and otherwise the release is refused.

Verification is permanent once earned. A later attempt or run of the same commit cannot
withdraw it, whether that attempt is a re-run still in progress, a flaky smoke test, a broken
staging token, or an older commit replayed over a newer staging schema. Those failures
describe the staging environment, not the source. A rule that let them withdraw verification
could let `migrate production` pass and `deploy production` refuse within one release.

The check runs twice, and both use the workflow's `GITHUB_TOKEN` with `actions: read` and
`contents: read`:

1. The `authorize` job runs `scripts/staging-verification.ts` before the `production`
   environment asks for reviewer approval.
2. `cloudflare-release.ts` repeats it immediately before `migrate production`,
   `deploy production`, and `import production`, and before any Wrangler call.

**A release must still be current.** Every push to `main` queues its own release, so
`cloudflare-release.ts` also refuses a release once `main` points at a commit with a
different tree: first in `plan-release`, before the D1 bookmark, then again before those
commands. An older run approved late, or re-run, never overwrites a newer Worker. Reject a release you don't intend to ship rather than leaving it waiting; a job
waiting for review stays queued for up to 30 days. Roll back with Cloudflare, not by
re-running an older release.

Only a pushed head gets its own Deploy Staging run, so when several commits land in one push,
only the last one is verified. If Deploy Staging is still running, wait for it. If the
`staging` head has no verified attempt (the run failed, a push skipped CI, or Actions had an
outage), start a new run on it, wait for it to pass, then re-run the production run:

```bash
gh workflow run web.yml --ref staging
```

Re-running the commit's own failed run also works. Re-running an older commit's run deploys
nothing: only the `staging` head deploys (`web.yml`'s `tip` job), so it can't verify that commit.

To check a commit from a maintainer machine:

```bash
GITHUB_TOKEN="$(gh auth token)" pnpm tsx scripts/staging-verification.ts <commit-sha>
```

The bootstrap gate matters even after the first import (run 36800330629). The bootstrap
applies every migration at its commit to an empty production database, for example a
re-created one. The publication and submission workflows change production data, not schema
or code, so they are not gated on staging by a check.

## Catalog data: staging first

Every reviewed catalog change reaches staging before production (#95, owner decision). A
manifest under `d1/publications/` is applied by **Publish D1 Catalog (staging)**
(`publish-d1-staging.yml`, dispatched from `staging` with `publish-best.serp.co-staging`, in the
`staging` environment, after recording a D1 Time Travel bookmark, never a database export),
checked there, and then, after promotion, by **Publish D1 Catalog** from `main`.

Listing media follows the same order. A plan under `d1/media/` is uploaded by **Upload Listing
Media (staging)** (`upload-media-best.serp.co-staging`) and later by **Upload Listing Media**
from `main` (`upload-media-best.serp.co-production`), which copies staging's verified objects
bucket to bucket through the R2 API, before the manifest that names its keys is published.

- `d1-remote-publisher.ts` and `media-upload.ts` each refuse to run outside their own workflow,
  branch, and confirmation; the publisher also refuses a database that is not its target's.
- The uploader refuses any key outside `best.serp.co/listings/` and verifies, never
  overwrites, an object the bucket already holds.
- The publisher refuses a media manifest until the target's own bucket holds every object it
  names, byte for byte.
- The publisher refuses any statement D1's remote API would reject
  (`scripts/d1-compat.ts`: no `PRAGMA`, temporary table, transaction control, or `ATTACH`). A
  publication guard fails its batch with `malformed JSON`, as the Worker's plans do.
- An upload failure names its cause (`fetch failed: <code> <message>`). `NETWORK_SMOKE=1` runs a
  real HTTPS fetch through the pinned Node fetcher (`apps/web/src/db/safe-fetch-node.test.ts`).
- Media, category, FAQ, and unpublish manifests are row-level (`concurrency: rows`): each fits
  both environments whatever else each published, and a listing that changed since generation
  refuses it with nothing written. Any other manifest still names the base version both
  environments must share.

Procedure: [Listing media](./MEDIA.md#uploading-and-publishing).

## Hotfixes

A hotfix that cannot wait for staging is a `hotfix-<n>-<slug>` branch from `main`, squash-merged
into `main` through a pull request. GitHub ignores `Closes #N` on a merge into `main`
(`issue-link` accepts it with a warning), so close the hotfix's issue by hand. Its push runs
Deploy Production, which stops at the staging check because staging never verified that tree.
To release it anyway:

1. The owner dispatches Deploy Production from `main` with `hotfix-best.serp.co-production`.
   `authorize` accepts it only when `main`'s head is the merge commit of a merged `hotfix-*`
   pull request from this repository (`staging-verification.ts --hotfix`), and records the
   skipped staging check in the run summary. The `production` reviewers still approve.
2. `cloudflare-release.ts` repeats that proof, then lets the dispatch run `deploy production`
   without the staging check. `plan-release` refuses a hotfix with pending migrations before
   the bookmark; a hotfix that needs a migration goes through staging.
3. Merge `main` into `staging` immediately: a pull request from `main` into `staging`, merged
   with **Create a merge commit**, the only merge commit `staging` takes. Until then `main` has
   a commit `staging` lacks, so `pnpm release:promote` refuses: `main` cannot fast-forward. A
   squash would never fix that, since it leaves the hotfix commit out of `staging`'s history.
   With a merge commit, Deploy Staging verifies the merged tree and the next promotion
   fast-forwards over it. GitHub remembers the last merge method, so switch the button back
   to **Squash and merge** for the next PR.

## D1 data stays in Cloudflare

No workflow exports a D1 database (#99). The repository is public, so any signed-in GitHub user
can download its workflow artifacts, and once accounts exist an export would hold session and
OAuth tokens, verification values, and submitter emails. Instead, each workflow step that can
change D1 directly follows a step running `cloudflare-release.ts bookmark <env>`. That read-only
command reads the Time Travel bookmark (`wrangler d1 time-travel info --json`), writes it and the
exact `wrangler d1 time-travel restore … --bookmark` command to the run summary, and fails when
it cannot. The endpoint accepts D1 Read, which the deploy token's D1 → Edit includes. Only the
owner restores ([D1 recovery](./D1_RECOVERY.md#restore-a-workflow-bookmark)).

`scripts/deploy-workflows.test.ts` enforces it:

- **Changes are found by credential, and the check fails closed.** A step holds a credential
  when its own `env` or `with`, or the job's or workflow's `env`, names a Wrangler credential
  variable in any case (`CLOUDFLARE_API_TOKEN`, the deprecated `CF_API_TOKEN`, the global
  `*_API_KEY` and `*_EMAIL`), or contains the word `secrets` anywhere, in any case, other than
  an exact `secrets.<name>` from a reviewed list (`GITHUB_TOKEN` and the Search Console secrets).
  The text is not parsed as expressions, so `secrets.cloudflare_api_token`, `secrets[...]`,
  `toJSON(secrets)`, and a `}}` inside a string literal all count. The job's `container` and
  `services` are read too. Every such
  step is a D1 change except a step whose whole `run` is one of a short reviewed list (the two
  credential checks, a read-only `cloudflare-release.ts` command, the Worker `deploy`, Deploy
  Production's plan step, and exactly `pnpm media:upload:<staging|production> -- "$PLAN_PATH"`,
  #95's R2-only upload, whose script imports nothing that reaches D1) **and** that has nothing else to change what runs: only the keys
  `name`, `id`, `if`, `env`, and `run`; only reviewed `env` entries with their exact values (no
  `NODE_OPTIONS`, `BASH_ENV`, or `LD_PRELOAD`); no `shell` or `working-directory`; and no
  `defaults` or other `env` on the job or workflow. Any other launcher (`npm`, a path such as
  `./node_modules/.bin/wrangler`, a script, an action) is a change, and so is the staging
  publish (`publish-d1-staging.yml`, after its bookmark). Any variant of the upload command (an
  extra argument or command, the script by path, an unreviewed `env`) is a change too. A
  bookmark step must meet the same rules.
- **No handoff.** A step holding the token, other than that list, may not write `GITHUB_ENV`,
  `GITHUB_PATH`, `GITHUB_OUTPUT`, or `GITHUB_STATE`, so it cannot pass the token to a later step.
  In a job holding the token, no `run` step may write `GITHUB_ENV` or `GITHUB_PATH` (only the
  reviewed install action, a `uses`, sets its own), and the job may not set `container` or
  `services`, so nothing outside a step changes what an exempt command runs.
- **A change runs only after a successful bookmark.** Its bookmark is the step right before it in
  the same job, for the job's environment, with the same `if:`. Neither step may use
  `continue-on-error` or a status function (`always()`, `failure()`, `cancelled()`,
  `success()`), so the implicit `success()` skips the change when the bookmark fails. A change
  that sets `CLOUDFLARE_D1_DATABASE_ID` must name its environment's database.
- **The weekly media health check changes nothing** (#122): its exact
  `pnpm media:health -- production --report …` command is a token step without changes (one D1
  `SELECT`, R2 list, CDN `HEAD`s), and the issue step after it holds no Cloudflare credential
  ([media health](./MEDIA_HEALTH.md#weekly-workflow)).
- **Nothing leaves as a file.** Only the reviewed uploads and caches are allowed (the Playwright
  reports, the staging smoke evidence, and the install action's dependency caches), matched by
  action, name, and path. No workflow runs `d1 export` or `cloudflare-release.ts backup`, and no
  script under `scripts/` passes `export` to Wrangler. In every job where any step holds the
  token (eight today, all checked), each step uses only reviewed actions and runs no `gh gist`,
  `gh release upload|create`, `gh api` file field, `curl` upload (`-T`, `--upload-file`, `-F`,
  `--form`, `-d @`, `--data-binary @`), or `wget` upload. Commands are read one at a time, split
  at `|`, `;`, `&`, and newlines.

**Adding a credentialed job.** A workflow change that gives a job `CLOUDFLARE_API_TOKEN` fails
these tests until the lists at the top of the "D1 data stays in Cloudflare" tests say what it
does: the job goes in `credentialedJobs`; each step that can change D1 follows its bookmark and
goes in `bookmarkedChanges`; a token step that cannot change D1 (an R2-only upload, for
example) gets its exact `run` in `tokenStepsWithoutChanges` with the reason; and new actions or
artifacts go in `credentialedJobActions` or `allowedUploads`. Each entry is reviewed with the
workflow.

These checks read workflow and script text, not data, and they are not a sandbox. Known
limits:

- A reviewed `pnpm` command runs repository code: a change to `cloudflare-release.ts` or a
  package script can do anything with the token, and only code review catches it.
- An upload by a program the parser does not name (`node -e "fetch(url, {method: 'POST'})"`,
  `python -c ...`, `nc`, or a renamed copy of `curl`) is not caught, and neither is a file written in a
  credentialed job and sent from a job without the token.
- An allowlisted artifact or cache path, a log line, or a job summary could still carry data.
- A remote reusable workflow or action is judged by its reference, not its content.
- A pull request can edit the checks themselves.

Review of every workflow and script change stays the control; the per-environment token split
(decision b) limits what a leaked token reaches.

## Security boundary

Until the token split, this is a process control, not a security boundary.

- **Narrowed:** the `staging` environment allows deployments only from the `staging` branch,
  and `production` only from `main`, so only workflows on those branches can use their
  secrets.
- **Still open:** both environments still hold the account-wide Cloudflare token (Edit on every
  Worker, D1 database, and R2 bucket, including serp.co's `cdn`), so a workflow merged to
  `staging` that uses the `staging` environment could still reach production directly. That
  path requires a pull request and the required checks, but no approving review.
- **No human gate on staging data:** the `staging` environment has no reviewers, so anything
  that can dispatch workflows can run the staging publication or upload. Agents never do
  (AGENTS.md); an optional `staging-data` environment would enforce it (MEDIA.md).

Decision b (the per-environment token split, right after cutover) closes that path.
