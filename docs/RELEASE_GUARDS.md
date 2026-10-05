# Database commands and release guards

How database commands name their targets, how changes move from `staging` to `main`, and how a
production release proves that staging verified the same source first. Environments,
workflows, and the release procedure itself are in the [deploy runbook](./DEPLOY_RUNBOOK.md).

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
| `pnpm db:migrate:staging` | staging D1 | `cloudflare-release.ts migrate staging`; runs only in `deploy-staging.yml` on `staging` |
| `pnpm db:migrations:list:production` | production D1 | Read-only: applied, pending, and unknown migrations |
| `pnpm db:migrate:production` | production D1 | `cloudflare-release.ts migrate production`; runs only in `deploy-production.yml` on `main` when `plan-release` finds pending migrations, after Deploy Staging verified the commit's tree |
| `pnpm db:publish:production`, `pnpm db:approve:production`, `pnpm db:notify:production` | production D1 | Data operations; each runs only in its own workflow |

The remote `migrations:list` commands run `cloudflare-release.ts list-migrations <env>`, which
reads the ledger with `wrangler d1 execute --remote --env <env>` and a `SELECT`. They do not
call `wrangler d1 migrations list`, because Wrangler's list first runs
`CREATE TABLE IF NOT EXISTS` on the ledger table. They work from a maintainer machine after
`wrangler login`.

Every D1 binding in `apps/web/wrangler.jsonc` declares `migrations_dir: "../../d1/drizzle"`
and `migrations_table: "d1_migrations"`. `pnpm worker:config:validate` and every
`cloudflare-release.ts` command refuse a binding that drifts.

## Promotion

The repository follows the serp git-workflow standard for repositories with Staging
(serpcompany/best.serp.co#42, decision d):

- **`staging` is the base branch.** Branch from it as `issue-<n>-<slug>` and open pull
  requests into it. The owner squash-merges them (the hotfix merge-back below is the one
  merge commit), and each push to `staging` runs Deploy Staging. Agents never merge.
- **`main` is production.** Changes reach it only by promotion: the owner opens a `staging` →
  `main` pull request and merges it with a **merge commit**, never a squash. Each push to
  `main` runs Deploy Production, whose release job waits for the `production` reviewers.
- **Only the owner releases.** Agents never dispatch a production workflow, never type a
  production confirmation, and never approve a deployment.
- **PR Review catches mis-targeted pull requests.** Once `staging` exists, `Validate Site &
  Policy` fails a pull request into `main` unless its head is this repository's `staging` or a
  `hotfix-*` branch (rulesets cannot restrict a head branch). It is an accident guard, not the
  control: a pull request runs its own copy of the check and could edit it. The control is
  the release-time tree check below.

Promote only a `staging` head that Deploy Staging has verified; otherwise Deploy Production
refuses the merge commit (see below) until it is.

## Staging before production

Deploy Production and Bootstrap Production D1 release only source that Deploy Staging has
verified on `staging`. Deploy Staging verified a commit when **any attempt** of a push or
dispatch run of `deploy-staging.yml` on `staging` completed all four steps successfully:

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
promotion merge commit is a new commit, but its tree equals the merged `staging` head's tree
whenever `main` had nothing that `staging` lacked. If `main` had diverged (a hotfix not yet
merged back), the merged tree was never on staging, and the release is refused. Merge `main`
into `staging`, let Deploy Staging verify the result, then promote again.

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
different tree: first in `plan-release`, before any backup export, then again before those
commands. An older run approved late, or re-run, never overwrites a newer Worker. Reject a release you don't intend to ship rather than leaving it waiting; a job
waiting for review stays queued for up to 30 days. Roll back with Cloudflare, not by
re-running an older release.

Only a pushed head gets its own Deploy Staging run, so when several commits land in one push,
only the last one is verified. If Deploy Staging is still running, wait for it. If the
`staging` head has no verified attempt (the run failed, a push skipped CI, or Actions had an
outage), start a new run on it, wait for it to pass, then re-run the production run:

```bash
gh workflow run deploy-staging.yml --ref staging
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

## Hotfixes

A hotfix that cannot wait for staging is a `hotfix-<n>-<slug>` branch from `main`, squash-merged
into `main` through a pull request. Its push runs Deploy Production, which stops at the
staging check because staging never verified that tree. To release it anyway:

1. The owner dispatches Deploy Production from `main` with `hotfix-best.serp.co-production`.
   `authorize` accepts it only when `main`'s head is the merge commit of a merged `hotfix-*`
   pull request from this repository (`staging-verification.ts --hotfix`), and records the
   skipped staging check in the run summary. The `production` reviewers still approve.
2. `cloudflare-release.ts` repeats that proof, then lets the dispatch run `deploy production`
   without the staging check. `plan-release` refuses a hotfix with pending migrations before
   any backup; a hotfix that needs a migration goes through staging.
3. Merge `main` into `staging` immediately: a pull request from `main` into `staging`, merged
   with **Create a merge commit**, the only merge commit `staging` takes. A squash would leave
   the hotfix out of `staging`'s history, so the promotion's merge base stays before it, and
   any later `staging` change to the same lines makes every `staging` → `main` promotion
   conflict, with no way to resolve it through a pull request. With a merge commit, Deploy
   Staging verifies the merged tree and the next promotion carries it. GitHub remembers the
   last merge method, so switch the button back to **Squash and merge** for the next PR.

## Security boundary

Until the token split, this is a process control, not a security boundary.

- **Narrowed:** the `staging` environment allows deployments only from the `staging` branch,
  and `production` only from `main`, so only workflows on those branches can use their
  secrets.
- **Still open:** both environments still hold the account-wide Cloudflare token, so a
  workflow merged to `staging` that uses the `staging` environment could still reach
  production directly. That path requires a pull request and the five required checks, but
  no approving review.

Decision b (the per-environment token split, right after cutover) closes that path.
