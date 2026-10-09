# Database commands and release guards

How database commands name their targets, how changes move from `staging` to `main`, and how a
production release proves that staging verified the same source first. Environments,
workflows, and the release procedure itself are in the [deploy runbook](./DEPLOY_RUNBOOK.md).
Catalog data and listing media reach staging first by their own procedure
([Catalog publication](./CATALOG_PUBLICATION.md)), and what a workflow holding the Cloudflare
token may do is in [Credential guards](./CREDENTIAL_GUARDS.md). Until each environment has its
own token, these guards are a process control, not a
[security boundary](./CREDENTIAL_GUARDS.md#security-boundary).

## Database commands

Every database command names its target, as the database standard requires. There is no
ambiguous `db:migrate`. The root `package.json` holds them.

- **No target.** `pnpm db:generate` writes a migration into `apps/web/drizzle/` and touches no
  database. `pnpm media:upload:dry-run -- <plan>` fetches and verifies every object of a media
  plan and writes nothing.
- **Local D1** (`db:*:local`): apply and list migrations, seed fixtures and check their facts,
  or apply a `d1/publications/` manifest.
- **Remote reads.** `pnpm db:migrations:list:<staging|production>` lists applied, pending, and
  unknown migrations from a maintainer machine after `wrangler login`. It reads the ledger with
  a `SELECT` through `wrangler d1 execute --remote` rather than `wrangler d1 migrations list`,
  because Wrangler's list first runs `CREATE TABLE IF NOT EXISTS` on the ledger table.
- **Remote writes** run only inside the protected workflow that owns them, from `staging` for
  staging and `main` for production. Deploy Staging runs `db:migrate:staging`; Deploy
  Production runs `db:migrate:production` only when its plan finds pending migrations, after
  Deploy Staging verified the commit's tree. The publication and upload workflows run
  `db:publish:<env>` and `media:upload:<env>`. Each script refuses to run outside its own
  workflow and branch, or on a dispatch without its typed confirmation
  (`releaseAuthorizations` in `scripts/cloudflare-release.ts` for the release commands).
- **`pnpm deploy:<env>`** is the owner-only emergency deploy that skips every guard here
  ([runbook](./DEPLOY_RUNBOOK.md)).

`pnpm worker:config:validate` and every `cloudflare-release.ts` command refuse a D1 binding in
`apps/web/wrangler.jsonc` whose migrations directory or ledger table drifts.

## Promotion

The repository follows the serp git-workflow standard for repositories with Staging:

- **`staging` is the base branch.** Branch from it as `issue-<n>-<slug>` and open pull
  requests into it. The owner squash-merges them (the hotfix merge-back below is the one
  merge commit), and each push to `staging` runs Deploy Staging. Agents never merge.
- **`main` is production.** `staging` reaches it by a **fast-forward**: the owner runs
  `pnpm release:promote` (`scripts/release-promote.ts`), so `main` receives exactly the squash
  commits staging verified, with no promotion pull request and no merge commit. The push needs
  the owner's bypass of `main`'s pull request and check rules, kept in a ruleset of their own so
  deletion and force pushes stay blocked for everyone. Any other change to `main` is a
  `hotfix-*` pull request. Each push to `main` runs Deploy Production, which waits for the
  reviewers.
- **Only the owner releases.** Agents never dispatch a production workflow, never type a
  production confirmation, and never approve a deployment.
- **CI catches mis-targeted pull requests.** Rulesets cannot restrict a head branch, so
  `web.yml`'s `check` fails a pull request into `main` unless its head is a `hotfix-*` branch
  of this repository. It is an accident guard, not the control: a pull request runs its own
  copy of the check and could edit it. The control is the release-time tree check below.

`pnpm release:promote` fetches, then refuses unless `main` is an ancestor of `staging` (after a
hotfix, merge `main` back first; see [Hotfixes](#hotfixes)), Deploy Staging verified the head of
`staging` (below), and the owner types the short SHA it shows at a terminal. It pushes that
exact commit, never forced. Agents never run it.

## Staging before production

Deploy Production releases only source that Deploy Staging has verified on `staging`. Deploy Staging verified a commit when **any attempt** of a push or
dispatch run of `web.yml` on `staging` completed every required `deploy-staging` step
successfully: the staging migration, Worker deploy, HTTP gates, and Playwright smoke
(`stagingWorkflow` in `scripts/staging-verification.ts` names them). A green attempt that
skipped those steps (for example, without staging credentials) does not count, and neither do
runs on other branches or `pull_request` runs.

**The released commit must have the tree of a verified staging commit.** The check accepts the
commit itself, verified on `staging` (a fast-forward, or a dispatch of that commit), or a commit
among the newest Deploy Staging runs on `staging` whose head has the same tree. The tree is
everything the release ships: source, migrations, configuration, and workflows. A fast-forward
promotion releases the verified commit itself. The tree rule covers a release commit that never
ran on staging, such as a merge commit: its tree equals a verified `staging` head's tree only if
`main` had nothing that `staging` lacked, and otherwise the release is refused.

**Verification is permanent once earned.** A later attempt or run of the same commit cannot
withdraw it, whether that attempt is a re-run still in progress, a flaky smoke test, a broken
staging token, or an older commit replayed over a newer staging schema. Those failures describe
the staging environment, not the source. A rule that let them withdraw verification could let
`migrate production` pass and `deploy production` refuse within one release.

The check runs twice, both times with the workflow's read-only `GITHUB_TOKEN`:

1. The `authorize` job runs `scripts/staging-verification.ts` before the `production`
   environment asks for reviewer approval.
2. `cloudflare-release.ts` repeats it immediately before `migrate production` and
   `deploy production`, before any Wrangler call.

**A release must still be current.** Every push to `main` queues its own release, so
`cloudflare-release.ts` also refuses a release once `main` points at a commit with a different
tree: first in `plan-release`, before the D1 bookmark, then again before those commands. An
older run approved late, or re-run, never overwrites a newer Worker. Reject a release you don't
intend to ship rather than leaving it waiting; a job waiting for review stays queued for up to
30 days. Roll back with Cloudflare, not by re-running an older release.

Only a pushed head gets its own Deploy Staging run, so when several commits land in one push,
only the last one is verified. If Deploy Staging is still running, wait for it. If the
`staging` head has no verified attempt (the run failed, a push skipped CI, or Actions had an
outage), start a new run on it, wait for it to pass, then re-run the production run:

```bash
gh workflow run web.yml --ref staging
```

Re-running the commit's own failed run also works. Re-running an older commit's run deploys
nothing (its tip guards), so it can't verify that commit.

To check a commit from a maintainer machine:

```bash
GITHUB_TOKEN="$(gh auth token)" pnpm tsx scripts/staging-verification.ts <commit-sha>
```

The publication and submission workflows change production data, not schema or code, so no check gates them on
staging; catalog data reaches staging first by procedure instead
([Catalog publication](./CATALOG_PUBLICATION.md)).

## Hotfixes

A hotfix that cannot wait for staging is a `hotfix-<n>-<slug>` branch from `main`, squash-merged
into `main` through a pull request. GitHub ignores `Closes #N` on a merge into `main`
(`issue-link` accepts it with a warning), so close the hotfix's issue by hand. Its push runs
Deploy Production, which stops at the staging check because staging never verified that tree.
To release it anyway:

1. The owner dispatches Deploy Production from `main` with the hotfix confirmation.
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
