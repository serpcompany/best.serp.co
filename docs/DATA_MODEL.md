# D1 data model

The schema is modeled once in `apps/web/src/db/schema.ts`. `pnpm db:generate`
(`drizzle-kit generate`) writes reviewable SQL into `apps/web/drizzle/`, and Wrangler applies
it while recording the `d1_migrations` ledger. `drizzle-kit push` is not an approved
migration path. Every D1 binding in `apps/web/wrangler.jsonc` declares the same `DB` binding and
migration settings, and the local config check and the release script refuse a binding that
drifts ([Release guards](./RELEASE_GUARDS.md#database-commands)).

Local, staging, and production are separate databases with the same schema and migration
history. A migration is applied locally (`pnpm db:migrate:local`), then to staging by
Deploy Staging, then to production by Deploy Production only after Deploy Staging verified
that commit (see [Release guards](./RELEASE_GUARDS.md#staging-before-production)).

Local data is a documented exception to the standard's "seeded fake/fixture data" rule
(owner decision a, serpcompany/best.serp.co#42). Local D1 is seeded with the real public
catalog from the committed import. That data is public and pinned, contains no submissions
or other user data, and the parity checks and Playwright suites need it. Submissions and any
future user data are seeded from fixtures only, never copied from staging or production.

## Tables

Column meanings and constraints are commented in `schema.ts`. By area:

- **Catalog**: categories, listings, their ordered category memberships (exactly one primary),
  media, resource links, FAQs, and slug redirects. What makes a listing public and the states
  it can be in: [Public catalog](./PUBLIC_CATALOG.md). Logos and images are hosted in R2,
  never hotlinked, and approvals and admin edits host a logo or queue it, never store its URL
  ([Listing media](./MEDIA.md)).
- **Publication**: `publication_state` is a single row holding the catalog version and
  checksum; `publication_runs` records every applied publication and `migration_runs` the import.
- **Intake and ownership**: submissions, owners, revisions, badge checks, claims, and orders:
  [Submission and ownership data](./SUBMISSION_DATA.md).
- **Activity**: `listing_events` is the log of admin and ownership changes to a listing, each
  row with its actor, written by the plan that makes the change.
- **Accounts and email**: Better Auth's tables, the admin allowlist, and the sign-in rate limits
  ([Accounts](./ACCOUNTS.md)); `email_deliveries`, the transactional email ledger
  ([Email](./EMAIL.md)). `email_deliveries` never holds a recipient or content, and
  `auth_rate_limit_hits` holds HMAC digests under a key derived from `BETTER_AUTH_SECRET`, never
  an email or IP address. `sessions` stores the client's raw IP address and user agent (Better
  Auth's default).

`scripts/d1-table-inventory.ts` is the exact table and column inventory that snapshot, parity,
and verification tooling read, so a schema change updates it in the same change. Tables written
at runtime (`runtimeTableNames`) are left out of bootstrap parity (`db:verify:local`,
`verify-import`), which requires them to be empty; every other table is compared exactly,
including the intake tables the import leaves empty.

## Hand-finished migrations

Drizzle cannot express everything the schema needs, so migrations are finished by hand. After
`pnpm db:generate`, replace the generated SQL with the hand-finished form and check that a
second `pnpm db:generate` reports no changes. Keep these properties in every migration:

- Every table is `STRICT`: end each `CREATE TABLE` with `STRICT` by hand.
  `PRAGMA foreign_keys = ON` leads `0000_baseline.sql`.
- Triggers are written by hand: the baseline's four enforce that a published listing always has
  exactly one primary category, and later ones refuse blocked URLs and keep published listings
  off retired categories.
- A migration that seeds a parity-compared table uses fixed values, as `0002_better_auth.sql`
  does for the admin allowlist's `created_at`, so bootstrap parity stays exact.
- D1 enforces foreign keys and runs a migration in one transaction, where
  `PRAGMA foreign_keys=OFF` has no effect. So a referenced table only gains columns
  (`ALTER TABLE ... ADD ... CHECK`), even where Drizzle generates a rebuild, as it does for a new
  CHECK. Never rebuild `listings`: dropping it would cascade-delete its memberships, media,
  links, and FAQs and drop the primary-category triggers.
- When a referenced table must be rebuilt, rebuild its children as `__new_*` tables that
  reference the new parent, and drop the old children before the old parent, so no drop
  cascades; the renames carry the references over. Recreate the table's triggers.
  `0003_submissions_data_model.sql` does this for `listing_submissions`.
- A foreign key's child columns need a full index: a partial index cannot serve SQLite's
  foreign-key checks, so deleting the parent would scan the child.
- A migration that drops a table or column ships only once the live Worker no longer reads it,
  because deploys migrate before they deploy.

`scripts/d1-drizzle-local.test.ts` applies the migrations to a populated database with foreign
keys enforced.

## D1 limits

D1 caps bound parameters, statement size, function arguments, and LIKE and GLOB pattern
length; `node:sqlite` applies none of these caps. Wrangler-local D1 (workerd) also caps compound
SELECT terms and expression depth, but does not enforce the function cap.
`apps/web/src/db/sql-limits.ts` holds the numbers. So:

- No CHECK or trigger uses LIKE or GLOB (ISO instants are checked by a round trip through
  `strftime`, `isoInstantCheck` in `schema.ts`), and no statement binds user input into a
  pattern. The architecture guard fails on a bound or concatenated LIKE/GLOB pattern, an
  over-long literal pattern, or a function call over the argument cap, in `src/db`, scripts, and
  migrations.
- The SQLite and workerd test helpers run every statement through `assertD1StatementLimits`,
  which also refuses a column compared with itself.
- The workerd suites run the statement plans and every catalog, search, account, email, and
  submission operation on workerd with the full import and worst-case inputs, with a rows-read
  budget per catalog query shape (harness step "D1 contracts").
- Search keeps its terms in one JSON binding matched with `instr()`, so it binds a fixed number
  of values whatever the query's length and needs no LIKE pattern
  ([Public catalog](./PUBLIC_CATALOG.md#search)).

## Statement plans

Every transition is a credential-free statement plan from `apps/web/src/db` (the `*-plans.ts`
modules, on the shared steps in `plan-support.ts`), sent as one D1 batch. Each mutation repeats
its expected state in the `WHERE` and is followed by a `changes() = 1` assertion, so a stale or
concurrent decision fails the whole batch and leaves nothing behind.

A plan that changes public output (publishing, unpublishing, content, `link_rel`, ownership) also
records a `publication_runs` row and advances `publication_state.version` with a
compare-and-swap (`prepareCatalogPublication` derives the ids and checksum), so cached pages
turn over. Approvals of revisions and live submissions move the listing to `draft` inside the
batch, replace its content, and publish it again, so the primary-category triggers stay in
force.

## Changing data

Catalog changes made outside the Worker use reviewed YAML manifests under `d1/publications/`.
The publisher validates the base version, prior checksum, IDs, slugs, URLs, and categories
before sending one batch, after recording a D1 Time Travel bookmark (no export). A manifest is
applied to staging first, then to production
([Release guards](./RELEASE_GUARDS.md#catalog-data-staging-first)). A row-level manifest
(`concurrency: rows`) checks each row it changes instead of a base version, so one manifest fits
both environments; `rowLevelActions` in `scripts/d1-publisher.ts` lists the operations it may
hold.

## Initial import

The catalog was bootstrapped once from `serpcompany/json-directory-template@25e2a8d`
(`sites/serp.co/products.json`, 3,422 listings, 141 categories) with `pnpm migration:generate`.
Listing IDs derive from the source slug (`stableIdAlgorithm` in the parity report), so
re-running the generator produces identical rows. `best-serp-co-v1-parity.yaml` records source
checksums, counts, the SQL checksum, and the target checksum written to `publication_state`;
`best-serp-co-v1.sql.br` is the committed brotli copy of the SQL that seeds local D1 and CI. The
uncompressed SQL and per-batch files are git-ignored. Remote environments are bootstrapped from
the same checksum-verified SQL by `bootstrap-production-d1.yml`, which imports only into an
empty database and then verifies exact parity with the report.
