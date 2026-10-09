# Archive

History, not live code. Local and CI data come from fixtures (serpcompany/best.serp.co#311), so
the one-time import of the v1 catalog from `serpcompany/json-directory-template@25e2a8d`, its
tooling, and the production D1 bootstrap built on it were moved here by #315. Production has
changed since through publications, admin decisions, claims, payments, and hosted media, so it is
never re-imported: recovery is D1 Time Travel ([D1 recovery](../docs/D1_RECOVERY.md)).

Each file keeps the path it had under this directory, as it was when archived. Imports name the
files as they were then, so nothing here builds or runs in place: to run something, check out the
commit before #315's merge.

Nothing reads this directory. It is outside the TypeScript and Vitest includes, Biome ignores it
(`biome.jsonc`), `docs:check`, the architecture guard, and the link checker skip it, and GitHub
runs workflows only from the root `.github/workflows/`, so the archived workflow never runs.

## What is here

| Archived | Was | What it did |
|---|---|---|
| `d1/artifacts/` | `d1/artifacts/` | The v1 import: its parity report and the brotli-compressed SQL (3,422 listings, 141 categories). The generated raw SQL and batches stay ignored where they were. |
| `scripts/migration/` | `scripts/migration/` | `pnpm migration:preflight`, `migration:generate`, `migration:compare` (page parity against best.serp.co), and `migration:legacy-media` (#95), with their tests. |
| `scripts/migration-preflight.test.ts` | `scripts/` | The preflight's test, which Harness Gardening ran. |
| `scripts/d1-import-artifact.ts`, `scripts/d1-application-snapshot.ts` | `scripts/` | Reading the checksum-verified import, and the exact table snapshot parity compared. |
| `scripts/v1-import-publications.test.ts` | `scripts/` | The committed manifests replayed on the import (#314 gathered them), and the import's slugs. |
| `scripts/listing-faq-move.ts`, `.test.ts` | `scripts/` | `pnpm catalog:faqs`, the generator of `d1/publications/2026-10-06-listing-faqs.yaml` (#105). |
| `.github/workflows/bootstrap-production-d1.yml` | `.github/workflows/` | Bootstrap Production D1: the import into an empty production D1 (`bootstrap-best.serp.co-production`). |
| `docs/PRODUCTION_BOOTSTRAP.md` | `docs/` | That workflow's runbook, rehearsal, and read-only checks. |

Parts of live files that served only the import were cut into files of their own:

| Archived | Cut from |
|---|---|
| `scripts/cloudflare-release-bootstrap.ts`, `.test.ts` | `scripts/cloudflare-release.ts` (`import`, `verify-import`) and its test |
| `scripts/d1-local-guard-import.ts`, `.test.ts` | `scripts/d1-local-guard.ts` (`pnpm db:import:local`, import parity in `db:verify:local`) and `scripts/d1-drizzle-local.test.ts` |
| `scripts/d1-table-inventory-parity.ts` | `scripts/d1-table-inventory.ts` (`runtimeTableNames`, `parityTableNames`) |
| `scripts/listing-domain-check-v1-import.ts` | `scripts/listing-domain-check.ts` (the import as `pnpm catalog:domains`' listing source; it now reads an environment's D1) |

Also removed: the package scripts `db:import:local`, `migration:*`, and `catalog:faqs`, and
`project.artifact` and `project.confirmation.bootstrap` in `scripts/project.ts`.
