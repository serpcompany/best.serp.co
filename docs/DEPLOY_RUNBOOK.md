# Deploy Runbook

Each active site is an OpenNext Cloudflare Worker backed by its own Cloudflare D1
database. GitHub Pages repo sync and local remote deploys are not supported.

| Site | Deployment workflow | Preview environment | Production environment |
| --- | --- | --- | --- |
| `serp.software` | `build-and-deploy.yml` | `serp-software-preview` | `production` |
| `pornvideodownloaders.com` | `deploy-pornvideodownloaders.yml` | `pornvideodownloaders-preview` | `pornvideodownloaders-production` |

## Local verification

These commands do not access a remote database:

```bash
pnpm worker:config:validate
pnpm test:d1
pnpm test:repo
pnpm typecheck
pnpm worker:build
```

Local D1 migration, import, publication, verification, and preview commands require
separate database-operation approval. They are guarded by
`scripts/d1-local-guard.ts` and can target only the checked-in local D1 identity.

## Protected Worker releases

Every Production D1 workflow for a Site uses the shared
`<site>-production-d1` concurrency group. During a replacement cutover, an active
reserved `migration_runs` lock freezes public Submission/rate-limit/verification
writes, publication, approval/rejection, notification delivery, and generic
Production migration/import. Public write APIs return `503` with code
`cutover_frozen`; operators must not bypass the lock. Completed or failed historical
lock receipts do not freeze writes.

Merging to `main` does not deploy either site automatically. Manually dispatch the
selected site's workflow from the reviewed `main` commit. The workflow requires:

- the site's protected Preview or Production environment;
- `deploy-<site-id>-<preview|production>` exactly; and
- successful configuration, D1 contract, type, and Worker build checks.

Routine SERP and PVD Preview/Production releases explicitly select
`D1_RELEASE_GENERATION=replatform`, the replacement D1 identity secrets, replacement
Wrangler templates, and `d1/drizzle/`. Publication, submission approval, and
notification workflows alias their canonical runtime variable names to those same
replacement secrets. The locked legacy source identities are never routine targets.

Each Site's deployment workflow accepts an explicit `preview` or `production` target.
Preview dispatches require the Site-specific protected Preview environment and exact
`deploy-<site-id>-preview` confirmation. Before the first remote backup, migration,
schema query, or deployment, the SERP workflow uses read-only Cloudflare observations
to prove the selected protected values match the checked-in active account, D1 UUID
and name, and Worker name. Wrong, stale source, Production, or PVD identities stop
before any remote operation. A successful SERP Preview deployment then
runs bounded route checks and the multisite Playwright smoke suite against the
protected environment's `PREVIEW_BASE_URL`, and retains the route report and browser
artifacts for 14 days. The Preview origin guard rejects either registered Production
hostname before Playwright runs.

Choose the release mode from the reviewed diff:

| Release mode | Select it when | Remote behavior |
| --- | --- | --- |
| `worker-only` | The commit adds no unapplied D1 migration and requires no newer schema. | Reads applied migration names to prove compatibility, then deploys the Worker. It does not back up, migrate, import, or write D1. |
| `database-and-worker` | The commit adds a migration, the target may be behind, or compatibility cannot be proven. | Production retains an export, applies forward migrations, proves schema compatibility, and deploys without replaying bootstrap data. Preview first retains an export, applies migrations, permits the initial catalog only for an empty database or as an exact-checksum no-op, verifies exact bootstrap parity, proves schema compatibility, and deploys. |

Do not use `worker-only` merely because a change is described as application code.
The workflow's `check-schema` operation compares every checked-in migration required
by that Worker commit with `d1_migrations` in the exact configured remote database.
It performs a read-only `SELECT` and fails closed; missing, duplicate, malformed, or
unavailable evidence stops the shell before the deploy command. The remediation is
to review the pending migrations and rerun the same commit as
`database-and-worker`, not to bypass the check.

The Production database-and-Worker path is always:

1. retained pre-change D1 export;
2. forward migrations;
3. read-only schema compatibility verification; and
4. Worker deployment.

A failed backup, migration, or schema verification stops before Worker deployment.
Production never runs the initial import or requires bootstrap parity during a
routine forward migration. The controlled routine Preview path deliberately matches
the existing PVD behavior: after backup and migration, `import` accepts only an empty
database or the reviewed bootstrap checksum as a no-op, and exact `verify` must pass
before schema proof and deployment. Any different or partial Preview publication
fails closed and requires recovery from the retained backup. Do not run Preview or
Production Wrangler or D1 commands from a local worktree.

## Initial site release and preview rehearsal

For every newly onboarded site, rehearse the same sequence first with its `preview`
target and exact `deploy-<site-id>-preview` confirmation. The preview job uses a
separate Worker, D1 database, protected environment, backup, and exact parity
verification. Run it once from empty publication state, then repeat it after the
catalog is populated to prove the identical checksum produces an import no-op before
authorizing production.

Issue #72 completed isolated replacement Preview rehearsals and Production cutovers
for both Sites. Their inactive source databases remain locked and retained through
2026-12-24 for the recorded recovery window; do not repurpose or delete them through
a routine release. See [the replacement cutover contract](./D1_CUTOVER.md).

### Completed fresh-D1 Production cutover

This subsection records the completed Issue #72 procedure. Its preparation,
provisioning, rehearsal, cutover, rollback, and finalization workflows are disabled.
Do not dispatch them as routine recovery or release operations. The complete current
state and evidence are in [the cutover record](./D1_CUTOVER.md).

The completed replacement transfer and binding switch ran only through protected
GitHub Actions. It consumed exact source/replacement D1 identities, Worker, account,
`PRODUCTION_BASE_URL`, a one-element `D1_CUTOVER_ALLOWED_SITE_IDS`, and the separately
reviewed exact-main Preview receipt.

The successful run URL, commit, cutover ID, receipt digest, source/target version IDs,
and backup expiry are retained on Issue #72 and in the cutover record. The historical
rollback path required both locks to remain active. Finalization marked the active
target lock successful, so that workflow is no longer directly executable and must
not be presented as a safe post-finalization rollback. Recovery now requires a new
reviewed plan that accounts for writes accepted by the active replacement database.

After stabilization was accepted, finalization proved the recorded target version was
solely active and both locks remained, then unfroze only the active target. The
inactive source remains locked. No database deletion or SQL restore occurred.

The disabled `rehearse-d1-replatform-preview.yml` workflow was the fresh-history
Preview executor. It required `rehearse-<site>-preview`, proved
the observed account and D1 identities, binds evidence to checked-out `GITHUB_SHA`,
and rehearsed the old binding before restoring the replacement binding. It contained
no Production mutation path and ran only from reviewed `refs/heads/main`. The retained
receipt matches the exact commit consumed by the completed Production cutover.

The historical executors proved exact account, D1, Worker, route, version, migration,
snapshot, and browser identities before each mutation. Preview used controlled or
sanitized data, temporary run-bound authority, repeated import no-op, real Submission
journeys, rollback/restoration, and explicit authority cleanup. Production consumed
the sealed exact-main Preview receipt, froze writes, copied one stable snapshot,
verified parity, rehearsed immutable-version rollback, and restored the target before
finalization. These facts are retained in the Issue #72 artifacts and summarized in
the cutover record; they are not a reusable runbook for current operations.

## Verified public submissions

Operational status: `.github/workflows/notify-d1-submissions.yml` is manually disabled
because the protected Production environments do not currently contain a durable
least-privilege `CLOUDFLARE_API_TOKEN`. Public intake can still stage and verify rows,
but the five-minute GitHub review-issue notification loop is paused and verified rows
may remain unnotified. Do not describe the review inbox as automatic until a durable
credential is installed, the active replacement D1 mapping is present on `main`, and
the workflow is explicitly re-enabled. There is no approved local or direct-D1
substitute for the paused notifier.

Public submissions are staged in normalized D1 tables and require a successful badge
verification. When enabled, `.github/workflows/notify-d1-submissions.yml` checks the
production review queue every five minutes and on manual dispatch. It creates or recovers one
private GitHub Issue, assigns the login configured in the
`SUBMISSION_REVIEWER_GITHUB_LOGIN` repository variable, and records the issue in D1.
The administrator sees pending work under the repository's assigned open Issues.
Each issue contains a private draft-preview link that renders the staged D1 row using
the production listing-detail UI. Treat it as a bearer secret: do not copy it outside
the private repository. The application stores only its SHA-256 digest, sends
`no-store` and `noindex` headers, and accepts it only while the row remains
`verified`.

Review the submitted fields, website, and badge in that issue, then manually run
`.github/workflows/approve-d1-submission.yml` from `main` with the site ID, submission
UUID, and exact `approve-<site-id>-submission-production` confirmation. The protected
workflow backs up D1, applies migrations, and promotes only a verified row while
recording publication provenance. Select `reject` to close a pending or verified
submission without publishing it. After the D1 decision succeeds, the workflow
comments on and closes the matching admin issue.
The successful D1 status transition also makes the draft-preview link return the
generic not-found page.

GitHub Issues are notifications only. Never edit an issue as a substitute for the D1
decision workflow, and never reconstruct a submission from issue text.

## Maintainer-authored catalog publication

Catalog changes follow a two-stage review path:

1. A maintainer authors a versioned manifest under
   `d1/publications/`.
2. From `main`, manually run `.github/workflows/publish-d1.yml` with the manifest's
   exact site ID.
3. Enter `publish-<site-id>-production` and approve that site's protected production
   environment.

The publication workflow retains a pre-change backup and sends the validated
manifest as one D1 batch. The publisher checks the tenant, base publication version,
prior checksum, stable IDs, slugs, categories, URLs, repeatable fields, and manifest
provenance before execution.

## Rollback

Every production mutation workflow retains the D1 export created before the change.
If rollback is required:

1. stop further publication and Worker release workflows;
2. identify the retained export from the affected workflow run;
3. review the export and intended recovery point;
4. obtain explicit production database-operation approval;
5. restore using the reviewed Cloudflare recovery procedure;
6. run exact catalog verification before resuming traffic changes or publication.

Never restore a production export merely because an application deploy failed; the
database may already contain a valid forward migration.

## Post-release checks

Functional QA and D1 efficiency QA are separate gates. A successful HTTP response
does not prove query efficiency.

After an authorized release, first record the workflow URL, commit, release mode,
target, Worker version/time, and retained backup artifact and expiry when the run
mutated D1. Confirm every selected workflow step and the production `DB` binding and
`D1_RUNTIME_ENV=production`.

Then run functional smoke checks:

- verify the home page and one representative category and product detail route;
- verify search, RSS, and sitemap routes;
- verify a legacy root product slug redirects to `/products/<slug>/`;
- confirm the page titles, listing ordering, related-card ordering, navigation
  boundaries, and empty/not-found behavior relevant to the change.

For a data-operation or schema-sensitive release, use a bounded UTC window and the
Cloudflare D1 dashboard, GraphQL analytics, or reviewed read-only tooling to record:

- exact cold and warm request URLs/counts and the observation timestamps;
- D1 query count and calls per route;
- query shape/operation, count, total and per-execution `rows_read`, `rows_written`,
  and latency;
- whether expected indexes appear in `EXPLAIN QUERY PLAN` when the change depends on
  them;
- the prior Worker version and backup needed for rollback.

Use the quantitative thresholds in the governing GitHub issue. For the shared catalog
optimization deployed on 2026-07-31, a controlled warm home/category/detail sample
must perform no stable summary/detail hydration, aggregate-count, related, media, or
navigation query. Each warm route should issue only its publication-version lookup,
with no more than two rows read per route; any unexplained application write or
return of the retired broad query shapes stops the rollout and triggers Worker
rollback review. Attribute one-time migration/index-maintenance writes only to the
`database-and-worker` workflow window—do not call them live application traffic.

Analytics access is not currently part of the deployment workflow's protected
credential contract, so this quantitative evidence is an explicit operator check,
not an automated workflow claim. Preserve it on the governing issue or ticket. Retain
every workflow backup for its required recovery window.

Provisioning a new site's Cloudflare databases, Worker names, route, environment
secrets, and GitHub environment protection is a one-time prerequisite. Before the
first mutation, use read-only calls to verify that the credential belongs to the
intended account and can see the exact resources. An account ID and API token are
different values even when the dashboard presents them together; never infer them
from clipboard order or labels. Record redacted identity evidence, resource IDs, and
workflow run URLs on the governing GitHub issue without committing credentials.

Issue #72's one-time PVD Preview and both Production replacement provisioners are
complete and disabled. Their resources are the active identities recorded in
[the cutover record](./D1_CUTOVER.md). Do not re-enable or dispatch those workflows
for a future site: onboarding must register new site-specific identities and follow
the current migration SOP. Retained provisioning receipts are historical evidence,
not authority to create, replace, or delete another resource.

For each new site, update and verify:

1. `scripts/site-targets.ts`, `configs/wrangler/<site-id>/`, and synthetic local
   identity;
2. preview and production D1 databases, Worker names/routes, and protected GitHub
   environments;
3. deploy workflow site choices, confirmation phrases, backup paths, and artifact
   retention;
4. shared publication, notification, submission approval, and sitemap workflow
   choices or matrices;
5. empty-state and populated-state preview releases, exact parity, public route
   checks, mobile screenshots, and element-containment assertions.

See [BUILD_PIPELINE.md](./BUILD_PIPELINE.md) for ownership and release architecture.
