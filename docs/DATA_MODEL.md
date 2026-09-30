# D1 data model

The application-owned schema is modeled once in `packages/data-ops/src/schema.ts`.
`drizzle-kit generate` writes a separate fresh-database history under `d1/drizzle/`,
and Wrangler applies that SQL while recording its canonical `d1_migrations` ledger.
The released `d1/migrations/0001`-`0009` files remain byte-for-byte immutable legacy
history for the locked, inactive source databases and are never scanned or combined
with the active fresh history. Canonical local development and routine
shared-environment releases use `d1/drizzle/` against fresh identities.
`drizzle-kit push` is not an approved shared-environment migration path.

The local replacement transfer preserves every application-owned source column and
excludes only SQLite, Wrangler, and Cloudflare-owned metadata. It compares canonical
per-table and whole-snapshot checksums, retains the target's fresh migration ledger,
and records one deterministic receipt in `migration_runs`. See
[D1 replacement-database transfer](./D1_REPLATFORM.md).

The same typed canonical encoding underpins prepared remote snapshot transfer. Values
retain their SQLite storage class, and integers cross JSON boundaries as decimal text.
A deterministic staging marker permits bounded retry only for the same Site, cutover,
source identity, schema, ledger, and snapshot; the final receipt replaces it only
after foreign-key and exact 17-table parity.

`migration_runs` also owns the reserved cutover lock namespace
`d1-cutover-lock-v1:<site>:`. A row in that namespace with `outcome='started'` freezes
all writes for only that Site. Successful/failed historical lock rows do not freeze
writes. The completed cutover executor owned lock creation and finalization. Ordinary
runtime and release paths still observe and enforce any active lock, while the
inactive source databases retain their historical lock rows as recovery evidence.

- `sites` identifies the tenant.
- `categories` stores active taxonomy rows and display order.
- `listings` stores public product fields, status, publication time, and stable IDs.
- `listing_categories` stores ordered many-to-many category membership.
- `listing_resource_links` and `listing_faqs` store repeatable detail content.
- `publication_state` records the current version and checksum.
- publication audit tables record applied manifests and operations.
- `listing_submissions` stores private pending, verified, approved, or rejected
  intake and only a digest of its public access capability.
- submission resource, FAQ, event, and rate-limit tables normalize repeatable data,
  state transitions, and abuse controls.
- `listing_submission_notifications` records the private GitHub review issue assigned
  for a badge-verified submission and the SHA-256 digest of its private draft-preview
  capability. The raw capability is never stored in D1. This table is an operational
  delivery ledger, not the submission source of truth.

Runtime Submission reads and writes are implemented once in `packages/data-ops/`
through an injected Site-explicit Drizzle client. Multi-row intake and conditional
state transitions use D1 batches. Verification, rejection, and approval transitions
follow each compare-and-swap statement with a D1-compatible `changes()` assertion in
that same batch. The assertion raises a SQLite JSON error unless exactly one expected
row changed, so stale or concurrent decisions roll back their events and every
catalog/publication/audit side effect.

Private preview hydration treats even verified staging rows as untrusted persisted
input. The shared mapper revalidates required listing text, category, date, website,
media references, and resource URLs before exposing a draft DTO.

D1-specific `STRICT` tables, checks, partial and collated indexes, and cross-table
publication triggers are preserved in the reviewed generated migration SQL. The
schema and relations remain the typed application model; reviewed SQL is the authority
for D1 features that Drizzle cannot express completely.

Public queries require the Worker-selected site ID, approved status, active rows, and
a publication time that is not in the future. `serp.software` and
`pornvideodownloaders.com` use separate local and production D1 databases as well as
tenant predicates, so an incorrect binding or site ID fails closed. Both Sites have
one isolated active replacement Preview database. The temporary Issue #72 source
Preview databases were deleted after retained exports and binding proofs; see
[the replacement cutover record](./D1_CUTOVER.md).

Public catalog reads are implemented once in `packages/data-ops/`. Each application
adapter supplies its validated D1 binding and checked-in site identity explicitly.
List and card operations return lightweight summary projections; detail operations
alone hydrate full content, media, and resource links. Stable published summaries,
completed details, category counts, and featured counts use site- and
publication-version-keyed data cache entries with one-hour retention and live D1
fallback on cache failure. A new publication version changes the key immediately;
the retention bound only limits orphaned entries. This does not enable public
full-page caching.

`listings_related_name_idx` is a partial public-listing index used only to preserve
the exact `name, slug` related-card ranking while seeking through eligible rows.
Draft, inactive, and unpublished rows are omitted from that index. Its additional
write/storage cost is accepted for publication-time changes; it is not evidence of
ongoing public-site writes.

Creating or badge-verifying a submission never satisfies those public predicates.
Only the protected submission approval workflow can promote a verified row into the
public tables, and that operation records publication provenance.

The scheduled notification workflow reads verified rows without a notification
ledger entry, creates or recovers one assigned issue in the private repository, and
records its number and URL in D1. Approving or declining still operates on the D1 row;
the issue is only the reviewer inbox. Private draft reads join the notification
ledger to the staged submission and require both a matching capability digest and
`verified` status, so either approval or rejection revokes access automatically.

Ongoing data changes use reviewed YAML manifests under `d1/publications/`. The D1
publisher validates the base version, prior checksum, IDs, slugs, URLs, categories,
and repeatable fields before sending one batch. YAML is a review envelope, not an
alternate runtime database.

`d1/artifacts/serp-software-v1.sql`,
`d1/artifacts/pornvideodownloaders-com-v1.sql`, and their batch/parity files preserve
the initial bootstraps. They are immutable release evidence and must not be treated
as editable catalog source.

Future initial site imports must follow [the migration SOP](./MIGRATION_SOP.md). The
presence of `site_id` columns does not by itself prove safe multisite runtime,
publication, backup, or deployment behavior. The per-site target registry and
protected workflows are part of that proof.
