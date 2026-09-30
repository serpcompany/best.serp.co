# D1 change rules

- The schema belongs in `packages/data-ops/src/schema.ts`; `pnpm d1:generate` writes
  migrations to `d1/drizzle/`, and Wrangler applies them. `drizzle-kit push` is
  forbidden.
- Migrations are forward-only and must keep the D1 specifics of the baseline
  (`STRICT` tables, primary-category triggers).
- `d1/artifacts/` holds the generated one-time import; only the parity report is
  committed. Never hand-edit generated SQL.
- Ongoing catalog changes use reviewed manifests under `d1/publications/`.
- Stable listing IDs survive slug changes; record old slugs in `listing_slug_redirects`.
- Staging and production backup, migration, import, and publication run only through
  protected workflows.

Read [the data model](../docs/DATA_MODEL.md) and
[deploy runbook](../docs/DEPLOY_RUNBOOK.md) before changing this directory.
