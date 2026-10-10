# Listing media

We host every listing logo and image; nothing is hotlinked. Hotlinked images are bad for SEO and
break whenever the source moves.

This page covers storage, keys, the D1 records, and rendering. Two leaves branch off it:

- [Media ingestion](./MEDIA_INGESTION.md): how a source URL becomes a hosted image, where the
  Worker hosts one (submissions, admin edits, revisions, approvals), and the media cron.
- [Media publishing](./MEDIA_PUBLISHING.md): catalog-wide changes through reviewed upload plans
  and manifests, recovering a refused manifest, and the legacy migration.

The fallback tile and the weekly media check: [image safety](./MEDIA_HEALTH.md).

## Owner decisions (2026-10-06)

- **Storage:** Cloudflare R2, read straight from the bucket's custom domain, never through the
  Worker. Production uses the existing `cdn` bucket on `cdn.serp.co`, under the `best.serp.co/`
  prefix; staging uses its own `cdn-staging` bucket on `cdn-staging.serp.co`, so staging can
  never overwrite production objects. The `r2.dev` URL stays disabled.
- **D1 stores the media key, not the URL.** Pages build URLs from the environment's media host,
  so one publication manifest fits staging and production.
- **SVG is refused**, because a same-host SVG can carry script.
- **All existing catalog images move** into the store; the
  [legacy migration](./MEDIA_PUBLISHING.md#legacy-migration) is a separate, reviewed step.

## Keys and objects

An image is stored once under a content-addressed key,
`best.serp.co/<scope>/<owner>/<logo|image>/<sha256-16>.<ext>` (`mediaKey` in
`apps/web/src/db/media-keys.ts`), with its `Content-Type` and R2's own SHA-256 check. A published
listing's images live under `listings/<slug>/`. A submission's images, and a listing revision's
new logo, live under `submissions/<id>/` or `revisions/<id>/` while they are reviewed, never
under a live listing's path.

- **A listing image never changes.** A changed image gets a new key, so a listing image is
  cached as immutable for a year and nothing is ever purged.
- **A pending image is short-lived.** A submission's or a revision's image is cached for five
  minutes, so deleting a rejected or withdrawn one takes it off the media host within minutes,
  with no zone purge.
- **Approval copies the reviewed bytes.** Approval queues a copy of the reviewed key into
  `listings/<slug>/` (the cron checks the stored bytes against the recorded SHA-256, type, and
  size before copying), and the cron deletes finished submissions' and revisions' images:
  approved and copied, rejected, or withdrawn (which covers an expired draft). A listing row
  only ever holds a `listings/` key.
- **A slug change keeps the media rows.** The key carries the slug, and a `listing-slug-change`
  manifest keeps the listing's media rows: re-host them under the new slug with a later
  `listing-media-update`, or media health reports them as `foreign_key`
  (`scripts/catalog-media.test.ts` holds committed manifests to that).
- **The production bucket is shared with serp.co.** `storeHostedMedia` is the only write to the
  bucket and refuses any key outside this site's three scopes, whatever bucket it is handed;
  `scopedMediaBucket` refuses the same before R2, and deletes only pending keys. The Worker never
  deletes a listing's image.

`scripts/project.ts` records each environment's bucket (the `MEDIA` binding) and media host
(`MEDIA_BASE_URL`), and the local and release config checks refuse a drifted one. Locally the
bucket is Wrangler state, and the Worker serves it at `/_media`. `next.config.ts` allows only
this site's listing keys on the two media hosts.

## D1

- A hosted `listing_media` row holds the key with its digest, type, size, and dimensions, all
  set or all null. `url` keeps where the bytes came from. A logo or image row without a key is
  an imported reference the legacy migration has not repointed yet; it renders as before until
  then.
- `media_ingestions` (a runtime table) holds the slots that are not hosted yet: one per listing,
  submission, or revision, kind, and sort order. A pending slot waits for the cron, a failed one
  stopped retrying and keeps its reason, and a submission's or a revision's slot becomes hosted
  with its pending key. A listing slot queued by an approval names the reviewed pending key to
  copy.
- The publisher writes manifest media as hosted `listings/` keys with their metadata, and a
  listing update deletes that listing's queue rows, so the cron never overwrites a publication.

## Rendering

The catalog reads a row's key where it has one, and its source URL where it is not hosted yet
(`mediaUrl` passes that through), so DTOs and the data cache hold keys for hosted rows.
The web adapter (`apps/web/src/lib/catalog/repository.ts`) turns keys into URLs on
`MEDIA_BASE_URL` and fails closed when the variable is missing or malformed. Listing JSON-LD
names the hosted logo, so on staging and in production it names the media host rather than
best.serp.co. A slot that is not hosted, or an image that fails to load, shows the fallback tile
([image safety](./MEDIA_HEALTH.md)).

The admin screens and the review previews render the same way (`renderableImage`): the hosted
copy, or an imported site-relative path on our own origin; a source on another host is shown as
the fallback tile with a "Source image" link, never loaded as an image. The submit page's
"already listed" card shows the listing's hosted logo. Only the submitter's own form previews
the URL they typed.

## Local development and tests

The local Worker serves its bucket at `/_media/<key>` (GET and HEAD, this site's keys only, never
on staging or in production). Locally, media fetches may use any port, for the e2e fixture sites
on `*.localtest.me:<port>`. `curl 'localhost:8787/cdn-cgi/handler/scheduled?cron=*/15+*+*+*+*'`
runs the media cron once; without `cron` the Worker runs no job.
`pnpm db:seed:local` hosts fixture logos through the real ingestion path (`seed-local-media.ts`);
the e2e media server (`apps/web/e2e/media-fixture.ts`) runs it and queues an unreachable logo, and
`listing-media.spec.ts` checks the rendered media against local R2.

## Owner setup

The `cdn-staging` bucket and both custom domains exist, and the deploy token
`best-serp-co-deploy` has Account → Workers R2 Storage → Edit
([deploy credentials](./DEPLOY_CREDENTIALS.md#cloudflare-api-token)).

### Optional owner actions

- **Lifecycle rules for pending images.** The cron deletes finished submissions' and revisions'
  images, but a row deleted outright (its queue rows cascade) leaves its objects behind. R2
  lifecycle rules (prefixes `best.serp.co/submissions/` and `best.serp.co/revisions/`, 365 days)
  catch those. Never put one on `best.serp.co/listings/` or the root (`cdn` is shared).
- **`nosniff` on the media hosts** (defense in depth; objects carry their sniffed type and SVG is
  never stored): a Response Header Transform Rule on `serp.co` for `cdn.serp.co` and
  `cdn-staging.serp.co` paths under `/best.serp.co/` setting `X-Content-Type-Options: nosniff`.
- **A human gate on staging data**:
  [Media publishing](./MEDIA_PUBLISHING.md#a-human-gate-on-staging-data).
