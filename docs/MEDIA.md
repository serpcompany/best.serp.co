# Listing media

We host every listing logo and image; nothing is hotlinked (serpcompany/best.serp.co#95).
Hotlinked images are bad for SEO and break whenever the source moves (#89).

## Owner decisions (2026-10-06)

- **Storage:** Cloudflare R2, read straight from the bucket's custom domain, never through the
  Worker. Production uses the existing `cdn` bucket on `cdn.serp.co`, under the `best.serp.co/`
  prefix; staging uses its own `cdn-staging` bucket on `cdn-staging.serp.co`, so staging can
  never overwrite production objects. The `r2.dev` URL stays disabled.
- **D1 stores the media key, not the URL.** Pages build URLs from the environment's media host,
  so one publication manifest fits staging and production.
- **SVG is refused**, because a same-host SVG can carry script.
- **All existing catalog images move** into the store; the legacy migration is a separate,
  reviewed step.

## Keys and objects

An image is stored once under a content-addressed, immutable key:

```text
best.serp.co/listings/<slug>/<logo|image>/<sha256-16>.<png|jpg|webp|gif|avif|ico>
best.serp.co/submissions/<submission-id>/<logo|image>/<sha256-16>.<ext>
```

with its `Content-Type` and R2's own SHA-256 check. A listing image is stored with
`Cache-Control: public, max-age=31536000, immutable`: a changed image gets a new key, so nothing
is purged. A submission's image is stored with `public, max-age=300`, so deleting a rejected or
withdrawn submission's image takes it off the media host within minutes, with no zone purge.

- A submission's images live under its own `submissions/<id>/` prefix while it is reviewed, never
  under a live listing's path. Approval queues a copy into `listings/<slug>/` (the cron checks
  the stored bytes against the recorded SHA-256, type, and size before copying), and the cron
  deletes a finished submission's images: approved and copied, rejected, or withdrawn (which
  covers an expired draft). A listing row only ever holds a `listings/` key (CHECK).
- `storeHostedMedia` is the only write to the bucket and refuses any key outside those two
  prefixes, whatever bucket it is handed; `scopedMediaBucket` refuses the same before R2, and
  deletes only `submissions/` keys. The production bucket is shared with serp.co.

| | local | staging | production |
| --- | --- | --- | --- |
| `MEDIA` binding | `best-serp-co-media-local` (Wrangler state) | `cdn-staging` | `cdn` |
| `MEDIA_BASE_URL` | `/_media` (served by `worker.ts`) | `https://cdn-staging.serp.co` | `https://cdn.serp.co` |

`scripts/project.ts` records both per environment, and the local and release config checks refuse
a drifted binding or host. `next.config.ts` allows both hosts for `/best.serp.co/listings/**`.

## D1

- `listing_media` gains `media_key`, `sha256`, `content_type`, `bytes`, `width`, and `height`,
  all set or all null (`listing_media_hosted_complete`, null-safe, no LIKE pattern). `url` keeps
  where the bytes came from. A logo or image row without a key is an imported reference the
  legacy migration has not repointed yet; it renders as before until then.
- `media_ingestions` (migration `0006`, a runtime table) holds slots that are not hosted yet: one
  per listing or submission, kind, and sort order. `pending` slots are due at `next_attempt_at`;
  `failed` slots stopped retrying and keep the reason; a submission's slot becomes `hosted`
  with its `submissions/` key. A listing slot queued by an approval carries `copy_from_key`, the
  submission key to copy (CHECK: only on listing slots, only a `submissions/` key).
- The publisher writes manifest media as hosted `listings/` keys with their metadata, and a
  listing update deletes that listing's queue rows, so the cron never overwrites a publication.

## Rendering

The catalog reads `COALESCE(media_key, url)`, so DTOs and the data cache (`v5`) hold keys. The
web adapter (`apps/web/lib/catalog/repository.ts`) turns keys into URLs on `MEDIA_BASE_URL` and
fails closed when the variable is missing or malformed. Listing JSON-LD names the hosted logo, so
on staging and in production it names the media host rather than best.serp.co. A slot that is not
hosted shows the #86 fallback tile.

The admin screens and the review previews render the same way (#96 review S9,
`apps/web/lib/media/renderable-image.ts`): the hosted copy, or an imported site-relative path on
our own origin; a source on another host is shown as the fallback tile with a "Source image"
link, never loaded as an image. The submit page's "already listed" card shows the listing's
hosted logo. Only the submitter's own form previews the URL they typed.

## Ingestion

`packages/data-ops/src/media-ingest.ts` fetches a source through the one shared `safeFetch`
(`packages/data-ops/src/safe-fetch.ts`, also submit v2's badge checks and prefill): every hop is
checked by `validatePublicHttpUrl`, at most three redirects, 8 s, a 5 MB cap, the response type
read as Fetch reads it, and for media only ports 80 and 443. It recognizes PNG, JPEG, WebP, GIF,
AVIF, and ICO by their bytes and checks each file's structure, not just its header
(`media-format.ts`: PNG chunks through `IEND`, a JPEG scan and end of image, the GIF trailer,
RIFF and ICO sizes, AVIF data), refuses more than 40 megapixels, SVG, and anything else, and
stores the bytes under their key. `media-operations.ts` records the result with statement plans
(`media-plans.ts`).

The Worker relies on Cloudflare's egress, which never reaches private addresses. A Node script
(the migration, the upload) may run on a self-hosted runner (#55) or a laptop, so it passes
`nodeFetch` (`safe-fetch-node.ts`): each hop's connection resolves its host once, refuses
private, loopback, link-local, ULA, IPv4-mapped, NAT64, and 6to4 addresses with the same
`public-url.ts` policy, and connects to exactly the checked address (an undici dispatcher's
`lookup`), so DNS rebinding cannot swap it; `Host` and TLS SNI stay the host's.

Where it runs:

- **Submit v2** (#84): saving a submission hosts its logo under `submissions/<id>/` after the
  response (`hostSubmissionImages` in `apps/web/lib/media/server.ts`), and its featured image:
  the social image the server's own prefill finds on the submitted website, never a URL the
  client sends. A changed logo replaces the copy. Intake refuses SVG logos and prefill skips SVG
  icons. Nothing here can fail the save.
- **Admin listing edit** (#64): `updateListingDetails` hosts a changed logo before its batch
  (`createMediaHost`). A logo that can never be hosted (SVG, not an image, 404, too large) is
  refused with a 422 that names the reason, and nothing is saved. A retryable failure saves, the
  screen warns with the reason instead of "Saved", the source is queued, and a hosted current logo
  stays until the new one lands. While it waits, the form shows the queued source, the preview
  the current logo, and the note says "New logo pending"; saving the current logo's URL again
  cancels the queued replacement.
- **Approvals** (`adoptStagedLogoPlans`, `adoptSubmissionImagePlans`): a listing logo row whose
  source is the staged logo is kept, hosted or not (so a revision or claim keeps an unchanged
  imported logo, relative and repo paths too); otherwise the submission's hosted logo is queued
  for a copy into the listing's path, or its source is queued. The featured image is adopted
  only as the reviewer saw it: the review screen and both previews show the hosted image (or why
  there is none), the approval sends that key back, and the batch is refused if the image
  changed since; a waiting or failed image, or a paid listing going live before review, adopts
  none. The approval then hosts the listing's queue after its response (`settle`).
- **Worker cron** (`*/15`, the `listing-media` job in `apps/web/lib/worker/scheduled.ts`): retries
  due slots, ten per run, each claimed with a ten-minute lease, then deletes finished
  submissions' images. Retryable failures (timeouts, unreachable hosts, 408, 429, 5xx, a failed
  write) back off 15 min, 1 h, 4 h, 12 h, 24 h, then 48 h; after the seventh attempt, or on any
  other failure (404, SVG, too large, not an image), the slot is `failed`.

### The cron never overwrites a newer write

A cron write applies only while its claim holds: the claimed row (id, lease, source) is still
there, and the listing's slot still holds what it held when the run read it
(`COALESCE(media_key,url)`). An admin edit, an approval, or a publication that touches the slot
meanwhile deletes or reschedules the row or changes the slot, so the cron's result (hosted or
failed) is refused inside its batch and counted as `superseded`, never retried, and the queue row
is not re-created. `media-plans.test.ts` and `media-operations.test.ts` reproduce the race (#96
review B1).

## Local development and tests

The local Worker serves its bucket at `/_media/<key>` (GET and HEAD, this site's keys only, never
on staging or in production). Locally, media fetches may use any port, for the e2e fixture sites
on `*.localtest.me:<port>`. `curl localhost:8787/cdn-cgi/handler/scheduled` runs the cron once.
`pnpm tsx scripts/seed-local-media.ts` hosts sample media through the real ingestion path, as the
e2e media server (`apps/e2e/tests/media-fixture.ts`) does on throwaway state;
`apps/e2e/tests/listing-media.spec.ts` checks the rendered media against local R2.

## Owner setup

Done on 2026-10-06: the `cdn-staging` bucket and both custom domains exist, and the deploy token
`best-serp-co-deploy` has Account → Workers R2 Storage → Edit (see the
[deploy runbook](./DEPLOY_RUNBOOK.md#cloudflare-api-token)).

### Optional owner actions

- **Lifecycle rule for submission images.** The cron deletes a finished submission's images, but
  a submission row deleted outright (its queue rows cascade) leaves its objects behind. An R2
  lifecycle rule on each bucket, prefix `best.serp.co/submissions/`, deleting objects after 90
  days, catches those. Never put a rule on `best.serp.co/listings/` or on the bucket root (the
  `cdn` bucket is shared with serp.co).
- **`nosniff` on the media hosts.** R2 custom domains do not send `X-Content-Type-Options`.
  Every object is stored with its sniffed `Content-Type` and SVG is never stored, so this is
  defense in depth: a Response Header Transform Rule on the `serp.co` zone, for requests whose
  hostname is `cdn.serp.co` or `cdn-staging.serp.co` and whose path starts with
  `/best.serp.co/`, that sets `X-Content-Type-Options: nosniff`. Nothing in this repository
  expects the header.
