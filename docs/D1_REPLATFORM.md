# D1 replacement-database transfer

Issue #69 adds a local-only, deterministic transfer boundary for moving one Site from
its current D1 schema generation into an empty database created from `d1/drizzle/`.
It does not connect to Cloudflare, choose a Preview or Production resource, change a
Worker binding, or authorize cutover.

## Application data inventory

Every listed column is preserved value-for-value. No application-owned source column
is excluded. The only import-time transformation is temporary and trigger-safe:
published Listings are inserted with `status = 'draft'`, their exact Category
relationships are inserted, and their original status is restored in the same
transaction. Explicit integer and text IDs are retained.

| Table | Preserved columns |
| --- | --- |
| `sites` | `id`, `created_at`, `updated_at` |
| `categories` | `id`, `site_id`, `slug`, `name`, `description`, `sort_order`, `is_active`, `created_at`, `updated_at` |
| `listings` | `id`, `site_id`, `slug`, `name`, `description`, `website`, `content`, `entity_type`, `priority`, `is_unofficial`, `is_featured`, `is_active`, `status`, `published_at`, `source_kind`, `source_identity`, `source_updated_at`, `checksum`, `created_at`, `updated_at`, `display_order` |
| `listing_categories` | `listing_id`, `category_id`, `sort_order`, `is_primary` |
| `listing_media` | `id`, `listing_id`, `kind`, `url`, `sort_order` |
| `listing_resource_links` | `id`, `listing_id`, `label`, `url`, `sort_order` |
| `listing_faqs` | `id`, `listing_id`, `question`, `answer`, `sort_order` |
| `publication_state` | `site_id`, `version`, `manifest_id`, `checksum`, `published_at` |
| `migration_runs` | `id`, `site_id`, `schema_version`, `manifest_identity`, `input_checksum`, `target_checksum`, `affected_records`, `outcome`, `error`, `started_at`, `completed_at` |
| `publication_runs` | `id`, `site_id`, `manifest_id`, `base_version`, `published_version`, `input_checksum`, `affected_records`, `affected_routes`, `outcome`, `error`, `started_at`, `completed_at`, `actor`, `workflow`, `before_checksum`, `after_checksum` |
| `listing_slug_redirects` | `id`, `site_id`, `listing_id`, `old_slug`, `new_slug`, `manifest_id`, `reason`, `created_at` |
| `listing_submissions` | `id`, `site_id`, `slug`, `name`, `description`, `website`, `content`, `category_slug`, `logo_url`, `video_url`, `status`, `access_token_hash`, `verification_attempts`, `last_verification_at`, `last_verification_error`, `badge_verified_at`, `reviewed_at`, `reviewed_by`, `listing_id`, `created_at`, `updated_at` |
| `listing_submission_resource_links` | `id`, `submission_id`, `label`, `url`, `sort_order` |
| `listing_submission_faqs` | `id`, `submission_id`, `question`, `answer`, `sort_order` |
| `listing_submission_events` | `id`, `submission_id`, `event_type`, `detail`, `actor`, `created_at` |
| `listing_submission_rate_limits` | `fingerprint_hash`, `window_started_at`, `request_count` |
| `listing_submission_notifications` | `submission_id`, `channel`, `external_id`, `external_url`, `recipient`, `created_at`, `updated_at`, `preview_token_hash` |

`d1_migrations`, `sqlite_sequence`, other `sqlite_*` objects, and Cloudflare `_cf_*`
objects are tool-owned and explicitly excluded from row transfer. The target retains
its fresh Wrangler migration ledger and schema objects. Any other table, missing
application table, or column mismatch fails before mutation.

The successful import appends one `migration_runs` receipt with a deterministic
identity whose reserved ID begins with `d1-replatform-v1:`. This is the only
intentional target-only application row. It records the Site, registered source
identity, source snapshot checksum, target checksum, affected row count, outcome,
and timestamps. Source audit rows remain unchanged and are included in parity; the
receipt is excluded from the source/target payload comparison to avoid
self-referential hashing.

## Local operation

First apply the immutable legacy history to a disposable source and the fresh
Drizzle history to a separate disposable target. Populate the source fixture or
restore a reviewed local D1 export, then run:

```bash
pnpm d1:replatform:local -- \
  --site serp.software \
  --source /absolute/path/to/source.sqlite \
  --source-database-id 00000000-0000-0000-0000-000000000002 \
  --target /absolute/harness-d1-state/drizzle/serp-software/fresh-target.sqlite \
  --target-database-id 00000000-0000-0000-0000-000000000068
```

Use the registered PVD local IDs for `pornvideodownloaders.com`. Source and target
must be existing, distinct local SQLite files. The target must be contained by the
selected Site's isolated fresh state root resolved from `HARNESS_D1_STATE_DIRECTORY`,
the current worktree's `.runtime/manifest.json`, or the ignored default
`.wrangler/drizzle-state/<site>/` directory. An arbitrary target path is rejected.
The source opens read-only with `query_only` enabled. The command accepts no remote
environment, URL, credential, Wrangler config, or default Site.

Before the first write the command proves:

- the source and target IDs match the selected Site's registered local identities;
- the source contains exactly that one Site and the immutable `0001`-`0009` ledger;
- every target table, index, trigger, foreign key, check, default, declared type,
  predicate, and SQL body has the exact normalized schema fingerprint produced by
  the reviewed fresh migration;
- the source has no foreign-key violations or reserved receipt; and
- every target application table is empty.

The import is one transaction. Integer reads use SQLite 64-bit `bigint` values so
valid values outside JavaScript's safe-number range are preserved. It preserves all
relationships and fails on any duplicate or target constraint. After commit, parity
verifies exact canonical row checksums and counts for every table, Listing ID and
slug sets, Category slug sets, foreign keys, state, ordering, timestamps, checksums,
and audit provenance.

A repeat is a no-op only when the receipt identity, source checksum, target checksum,
and complete parity all match. A populated target without a receipt, different
source snapshot, partial import, changed relationship, or any other unexplained
difference fails closed. Recovery is to discard the disposable target, apply the
fresh schema to a new empty target, and repeat; this tool never repairs or resumes a
partial database.

Run the focused regression with:

```bash
pnpm exec vitest run scripts/d1-replatform.test.ts
```

The fixtures cover both Sites and every application table, including Publication,
Submission, notification, rate-limit, and audit data. They use only temporary local
SQLite files.

## Canonical snapshot engine

`scripts/d1-application-snapshot.ts` is the shared application-data encoding used by
local transfer, Preview measurement, legacy classification, and the prepared
Production snapshot boundary. It reads the exact 17-table inventory in bounded,
deterministically ordered pages. Every SQLite value carries an explicit storage type;
integers are encoded as decimal text before crossing a JSON boundary, so valid signed
64-bit values never pass through an unsafe JavaScript number. Per-table and whole
snapshot SHA-256 values use the same encoding in every environment.

`scripts/d1-replatform-snapshot-transfer.ts` builds on that engine without selecting
credentials, an environment, or a remote resource. It captures the frozen legacy
source twice and requires an independently observed source UUID plus identical Site,
schema, immutable `0001`-`0009` ledger, active cutover-lock, table, and checksum proof.
Materialization requires the exact
fresh schema and ledger, writes bounded `INSERT OR IGNORE` batches, and resumes only
when a deterministic staging marker matches the same cutover and snapshot. Existing
partial rows must be exact members of that snapshot; divergent state fails closed.
The final target receipt replaces the staging marker only after foreign-key and exact
17-table parity succeed.

This is transport-neutral preparation, not a Production executor. It contains no
Cloudflare credential acquisition, resource selection, workflow, Worker rebind, or
remote command. Exercise it locally with:

```bash
pnpm exec vitest run scripts/d1-replatform-snapshot-transfer.test.ts
```
