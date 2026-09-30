# Maintainer onboarding

This repository currently operates two deployable D1-backed sites:
`serp.software` and `pornvideodownloaders.com`. Each has a separate app, Worker,
local state, production database, production environment, and release workflow.
Both have isolated active Preview Worker/D1/environment resources. Their temporary
source Preview databases were deleted after the Issue #72 cutover; retained evidence
is recorded in the D1 cutover record.
`scripts/site-targets.ts` is the exhaustive executable-site registry.

Start with [`AGENTS.md`](../AGENTS.md), then use the
[documentation index](./README.md). Read [Architecture](./ARCHITECTURE.md),
[Data model](./DATA_MODEL.md), [Development](./DEVELOPMENT.md), and
[Harness](./HARNESS.md). Checked-in presentation settings live under
`sites/<site-id>/`; catalog data lives only in that site's D1 database.

Schema work belongs in `packages/data-ops/src/schema.ts` and reviewed generated SQL
under `d1/drizzle/`; never rewrite the legacy `d1/migrations/0001`-`0009` history.
Public intake is staged in normalized D1
submission tables, and maintainer-authored mutations belong in `d1/publications/`.
Never create a starter/default site, catalog file, source adapter, or file-backed
fallback.

Substantial work is planned and tracked in GitHub Issues using the workflow in
[`AGENTS.md`](../AGENTS.md). Onboarding another legacy site follows the complete
[migration SOP](./MIGRATION_SOP.md). Adding a directory under `sites/` or a Site row
is not sufficient: the registry, app, local guard, artifacts, tests, Worker/D1
configuration, protected environments, workflows, and evidence must all be extended
and proven as one isolated Site boundary.
