# Production D1 bootstrap

**Bootstrap Production D1** (`bootstrap-production-d1.yml`, dispatched from `main` with
`bootstrap-best.serp.co-production`) loads the reviewed initial catalog into an empty production
D1. It ran once before the [cutover](./PRODUCTION_CUTOVER.md) (run 36800330629) and stays for a
re-created database. Because it applies every migration at its commit, it is gated on staging
like a release ([Release guards](./RELEASE_GUARDS.md#staging-before-production)). Where the
import comes from: [Data model](./DATA_MODEL.md#initial-import).

## What a run does

1. Records a D1 Time Travel bookmark, as before every D1 change
   ([deploy runbook](./DEPLOY_RUNBOOK.md#bookmarks-and-recovery)).
2. `import` refuses a database that holds any publication, catalog, or `migration_runs` row
   before changing anything. It then applies the migrations, decompresses
   `d1/artifacts/best-serp-co-v1.sql.br`, refuses it unless its sha256 equals the parity
   report's `artifact.sqlChecksum`, and imports it in one D1 execution. If the execution
   fails, D1 rolls it back and the run can be repeated. A repeat right after success is a
   no-op.
3. `verify-import` requires the runtime tables (`runtimeTableNames`) to be empty, so an import
   that planted a user, session, code, or delivery cannot pass. It compares every other table
   with an in-memory bootstrap of the same SQL, and checks the publication checksum, version,
   and every count in the parity report.

Then run **Deploy Production**. The bootstrap already applied the migrations, so it plans
`worker-only`.

Both commands describe the database as the bootstrap leaves it. After a later publication,
`import` refuses the database as occupied; after that or any other write (a sign-in, a
submission), `verify-import` fails. Neither is a health check of a live database.

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
against staging both produced the exact 16-table snapshot `69a7bae9…e477`, with the parity
report's counts. The staging HTTP gates and the Playwright smoke suite passed against the
staging Worker.
