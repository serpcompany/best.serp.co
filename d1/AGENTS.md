# D1 change rules

- The shared schema belongs in `packages/data-ops/src/schema.ts`; `drizzle-kit generate`
  writes the fresh history to `d1/drizzle/`, and Wrangler applies it.
- Fresh migrations are forward-only, ordered, idempotent where practical, and tested
  against an empty isolated local database. `drizzle-kit push` is forbidden.
- `d1/migrations/0001`-`0009` is immutable release history for the existing databases.
  Never merge it into, copy it into, or make Drizzle scan it as part of the fresh history.
- Never edit an artifact that has participated in a release.
- Initial import artifacts require source hashes, row counts, exact slug parity, and a
  publication checksum.
- Ongoing mutations use reviewed manifests under `publications/`; proposals do not
  mutate a database.
- Stable listing IDs survive slug changes.
- Production backup, migration, import, verification, and publication run only
  through protected workflows.

Read [the data model](../docs/DATA_MODEL.md), [migration SOP](../docs/MIGRATION_SOP.md),
and [deploy runbook](../docs/DEPLOY_RUNBOOK.md) before changing this directory.
