# Media publishing

A catalog-wide media change (the legacy migration, or a regeneration of it) reaches staging and
then production as reviewed files, uploaded and published by protected workflows. Keys and
storage: [Listing media](./MEDIA.md). Why staging comes first:
[Catalog publication](./CATALOG_PUBLICATION.md).

Agents prepare and review these files; they never run the uploads or publications.

## Uploading and publishing

A change is two reviewed files: an upload plan under `d1/media/` (each object's key, digests,
metadata, and source: a public https URL or a `repo:` file under `apps/web/public`) and
row-level manifests under `d1/publications/` that name the keys.
`pnpm media:upload:dry-run -- d1/media/<plan>.json` fetches and verifies every object locally and
writes nothing. The owner then runs, in order, each with its typed confirmation
(`project.confirmation` in `scripts/project.ts`):

1. **Upload Listing Media (staging)** from `staging`. Every object is fetched again and uploaded
   only if its bytes still match the plan.
2. **Publish D1 Catalog (staging)** from `staging`, once per manifest (all row-level, in any
   order), and check staging.
3. After the `staging` → `main` promotion: **Upload Listing Media**, then **Publish D1 Catalog**
   for the same manifests.

A source that changed between the plan and the staging upload fails that object
(`sha256_mismatch`); regenerate the plan for it, then rerun the upload, which skips the rest.

## How the steps protect each other

- **Bucket to bucket.** The production upload copies each object from the `cdn-staging` bucket
  through the R2 API, never through a CDN, so it gets the bytes staging verified whatever the
  source or an edge cache does since.
- **Existing objects are verified, never trusted.** A plan pins each object's SHA-256 and MD5,
  taken from the same reviewed bytes. The bucket is listed, since one read per object would
  spend the API's rate limit, and an object counts as present only when its size, type, cache
  policy, and ETag, which R2 computes as the stored bytes' MD5, match: a rerun finishes what is
  missing, and a mismatch fails that key (`present_mismatch:…`) and is never overwritten. A
  PUT's returned ETag must be its bytes' MD5.
- **Rate limited.** Every R2 call shares one limiter, set under the Cloudflare API's limit for
  the whole token, and retries a 429 or 5xx after its `Retry-After` or a backoff
  (`scripts/r2-objects.ts`). A staging run of the full legacy plan (about 3,700 objects) took
  about 15 minutes; production copies each object with two calls, about 45 minutes.
- **Upload before publish is enforced.** The publisher lists the target's own bucket and refuses
  the manifest unless each object matches its plan the same way.
- **Row-level manifests.** A media manifest says `concurrency: rows` and names no base version.
  Each listing carries its `expected` logo and image rows (kind, source URL, hosted key), and
  the batch applies only while they still match, so one manifest fits staging and production
  whatever else each published (admin edits, approvals, the media cron). The publisher reads
  the live publication state, checks every listing first, and still advances the version;
  rerunning a published manifest is a no-op.
- **Its own queue.** Uploads run in their own concurrency group per environment, never a
  deploy's.

## Recovering a refused media manifest

A publication that reports "listings changed since this manifest was generated" wrote nothing.
Some listing's logo or images changed on that environment after generation (an admin edit, an
approval, or the cron hosting a queued slot). A row-level manifest fits only the rows it was
generated from, so recovery keeps staging first:

1. Regenerate the plan and manifests from **staging's** current rows (`--current`, see
   [Regenerating](#regenerating)) with **new manifest ids** (`--manifest-id`): an id that
   already succeeded is refused as "already used by different content". Review the diff.
2. Upload the new plan to staging and publish the new manifests on staging, then, after the
   promotion, upload and publish them on production.

Manifests that published stay published, and regenerated ones leave their listings out. A
listing that changed only on production stays refused there; it keeps its production media
until its rows match staging's again, and is never repointed without the staging check.

## Legacy migration

`pnpm migration:legacy-media` (`scripts/migration/legacy-media.ts`, whose header holds the
details) resolved every logo and image of the imported catalog into the upload plan
`d1/media/2026-10-06-legacy-media.json` and its row-level manifests, all published on
production. Every count, the refused replacements, and each logo left on the tile are in the
[report](../d1/media/2026-10-06-legacy-media.report.md).

The owner's rules for a source that is dead, not a hostable image, or a default asset still hold
for any regeneration:

- **Default assets are missing.** `DEFAULT_ASSETS` lists by SHA-256 the images that are not the
  product's own (the placeholder chevron of many imported logos, framework favicons and logos,
  builder default images, for-sale page icons); they are treated as missing wherever they
  appear.
- **Replacements come only from the listing's own page.** The final page, after redirects and a
  short link's meta refresh, is on the listing's registrable domain (its website's or its
  slug's), or is the SERP app's apps.serp.co page; a dead short link that ends on serp.co's
  catch-all falls back to the slug's domain. It is not a parking, for-sale, gambling, or spam
  page (`pageFlags`). The logo is the site icon, at least 64 px; the featured image is the
  social image.
- **Rebrands need the owner.** An off-domain page with the same brand is listed as a "likely
  rebrand"; the owner approves one with a line in
  `scripts/migration/legacy-media-allowed-domains.json` or `--allow-domain <slug>=<domain>`, and
  the next regeneration takes it, even with no rows left (the `--current` export adds approved
  slugs), as the `2026-10-07-legacy-media-rebrands` plan did.
- **Adult listings** never took another site's Open Graph image, only SERP's curated screenshot
  from apps.serp.co; their site icons were fine. The catalog no longer lists adult products
  ([Catalog hygiene](./CATALOG_HYGIENE.md#adult-products-260)).
- **Owner sign-off.** A refused replacement leaves the tile and is listed in the report with its
  final page and reason. Listing content never changes here; hijacked listings are
  [catalog hygiene](./CATALOG_HYGIENE.md#listing-domains)'s.
- `scripts/catalog-media.test.ts` applies the manifests to the import and checks that every logo
  and image is then a hosted key with a matching object in the plan, and that nothing else
  changes.
- **Deleted `repo:` files.** Once production had published every part, the plan's `repo:` files
  were deleted. The plan still names them, and their bytes stay in Git at the commit
  `scripts/media-repo-archive.ts` records, where the migration reads them. The uploader never
  reads Git, so a dry run or rerun of the plan needs them restored first; the report has the
  restore command.

### Regenerating

Fetches are cached under `.runtime/legacy-media-cache`, through the DNS-checked Node fetcher, so
a rerun reproduces the outputs byte for byte. The script's header lists every flag; a recovery
uses these:

- `--manifest-id <id>` names a regeneration.
- `--refresh <upload summary JSON>` refetches the source of every object the upload reported as
  failed, whatever the reason (a drifted source usually fails on its byte count, before its
  digest), so those keys follow the new bytes.
- `--current <dir>` regenerates from an environment's current rows instead of the import (after
  a refused publication). Rows already hosted are kept as they are; only the rest is resolved.
  The owner exports the rows read-only into the directory:

```bash
for table in listings media; do
  pnpm exec wrangler d1 execute best-serp-co-staging --env staging --remote --json \
    --config apps/web/wrangler.jsonc \
    --command "$(pnpm -s migration:legacy-media -- --snapshot-sql "$table")" > "<dir>/$table.json"
done
```

## A human gate on staging data

The `staging` environment has no reviewers, so anything that can dispatch workflows could run the
staging publication or upload. A `staging-data` environment (deployments from `staging` only, the
owner as required reviewer, the same two secrets) used by `publish-d1-staging.yml` and
`upload-media-staging.yml` would enforce what AGENTS.md states, as `production` does for
production. It is an optional owner action, not created yet.
