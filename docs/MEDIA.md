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
```

with `Cache-Control: public, max-age=31536000, immutable`, its `Content-Type`, and R2's own
SHA-256 check. A changed image gets a new key, so nothing is purged. Every write goes through
`scopedMediaBucket`, which refuses a key outside `best.serp.co/listings/` (the production bucket
is shared with serp.co).

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
  with the result so its approval can adopt it.

## Rendering

The catalog reads `COALESCE(media_key, url)`, so DTOs and the data cache (`v5`) hold keys. The
web adapter (`apps/web/lib/catalog/repository.ts`) turns keys into URLs on `MEDIA_BASE_URL` and
fails closed when the variable is missing or malformed. Listing JSON-LD names the hosted logo, so
on staging and in production it names the media host rather than best.serp.co. A slot that is not
hosted shows the #86 fallback tile.

## Ingestion

`packages/data-ops/src/media-ingest.ts` fetches a source through `safeFetch` (every hop checked
by `validatePublicHttpUrl`, at most three redirects, 8 s, a 5 MB cap), recognizes PNG, JPEG,
WebP, GIF, AVIF, and ICO by their bytes (`media-format.ts`, with dimensions), refuses SVG and
anything else, and stores the bytes under their key. `media-operations.ts` records the result
with statement plans (`media-plans.ts`). Where it runs:

- **Admin listing edit** (#64): `updateListingDetails` hosts a changed logo before its batch
  (`createMediaHost`); the batch writes the hosted row, or queues the source with the first
  failure. The listing page shows a waiting or failed logo with its reason.
- **Approvals** (`adoptStagedLogoPlans`): a live hosted logo of the same source is kept, a
  submission's hosted copy of it is adopted, otherwise the source is queued.
- **Worker cron** (`*/15`, `runMediaCron`): retries due slots, ten per run, each claimed with a
  ten-minute lease. Retryable failures (timeouts, unreachable hosts, 408, 429, 5xx, a failed
  write) back off 15 min, 1 h, 4 h, 12 h, 24 h, then 48 h; after the seventh attempt, or on any
  other failure (404, SVG, too large, not an image), the slot is `failed`.
- **Submit v2** (#84) calls `hostSubmissionMedia` from `apps/web/lib/media/server.ts` when a
  submission names its logo or social image; see "Integration points" below.

## Local development and tests

The local Worker serves its bucket at `/_media/<key>` (GET and HEAD, listing keys only, never on
staging or in production). `curl localhost:8787/cdn-cgi/handler/scheduled` runs the cron once.
`pnpm tsx scripts/seed-local-media.ts` hosts sample media through the real ingestion path, as the
e2e media server (`apps/e2e/tests/media-fixture.ts`) does on throwaway state;
`apps/e2e/tests/listing-media.spec.ts` checks the rendered media against local R2.

## Owner setup

Done on 2026-10-06: the `cdn-staging` bucket and both custom domains exist, and the deploy token
`best-serp-co-deploy` has Account → Workers R2 Storage → Edit (see the
[deploy runbook](./DEPLOY_RUNBOOK.md#cloudflare-api-token)).

## Integration points

Submit v2 (#84), not yet on `staging`:

- After a submission's logo or social-image URL is saved, call
  `(await mediaOperations()).hostSubmissionMedia({ submissionId, kind, sortOrder: 0, sourceUrl })`.
  It hosts the image or queues it; approval then adopts the hosted copy.
- Import `safeFetch` and the site metadata parser from `@serpdirectory/data-ops/safe-fetch` and
  `@serpdirectory/data-ops/site-metadata` instead of the copies in `apps/web/lib/submissions/`.
- Refuse SVG logos at intake (or prefer raster icons: `iconCandidates(..., { vector: false })`):
  an SVG is never hosted, so it would leave the fallback tile.
- The review preview should show the hosted copy (`submissionMedia`) rather than the source URL.
