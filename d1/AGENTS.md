# D1 change rules

- The schema belongs in `packages/data-ops/src/schema.ts`; `pnpm db:generate` writes
  migrations to `d1/drizzle/`, and Wrangler applies them. `drizzle-kit push` is
  forbidden.
- Migrations are forward-only and must keep the D1 specifics of the baseline
  (`STRICT` tables, primary-category triggers).
- `d1/artifacts/` holds the one-time import. Only the parity report and
  `best-serp-co-v1.sql.br` are committed; never hand-edit generated SQL.
- Ongoing catalog changes use reviewed manifests under `d1/publications/`.
- Stable listing IDs survive slug changes; record old slugs in `listing_slug_redirects`.
- Staging and production backup, migration, import, and publication run only through
  protected workflows. Production migrates only a commit that Deploy Staging already
  migrated and smoke-tested. `pnpm db:migrations:list:<local|staging|production>` is
  read-only.

Read [the data model](../docs/DATA_MODEL.md) and
[deploy runbook](../docs/DEPLOY_RUNBOOK.md) before changing this directory.
