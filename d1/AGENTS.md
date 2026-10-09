# D1 change rules

- The schema belongs in `apps/web/src/db/schema.ts`; `pnpm db:generate` writes
  migrations to `apps/web/drizzle/`, and Wrangler applies them. `drizzle-kit push` is
  forbidden.
- Migrations are forward-only and must keep the D1 specifics of the baseline
  (`STRICT` tables, primary-category triggers).
- The one-time v1 import is retired; its artifacts are history in `.archive/d1/artifacts/`
  (#315). Local data is the fixture seed (`pnpm db:seed:local`), never the real catalog.
- Ongoing catalog changes use reviewed manifests under `d1/publications/`, applied to staging
  first. `d1/hygiene/` holds the listing domain check's reports, the evidence behind its
  unpublish manifests. Listing media uploads use reviewed plans under `d1/media/` (no image
  files, #95).
- Stable listing IDs survive slug changes; record old slugs in `listing_slug_redirects`.
- Staging and production migration, publication, and media uploads run only through
  protected workflows, each D1 change after a D1 Time Travel bookmark; no workflow exports D1.
  Production migrates only a commit that Deploy Staging already migrated and smoke-tested.
  `pnpm db:migrations:list:<local|staging|production>` is read-only.

Read [the data model](../docs/DATA_MODEL.md) and
[deploy runbook](../docs/DEPLOY_RUNBOOK.md) before changing this directory.
