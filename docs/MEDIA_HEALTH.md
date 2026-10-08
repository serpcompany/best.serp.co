# Listing image safety and media health

A listing image never renders as a broken image, and hosted media is checked every week
(serpcompany/best.serp.co#122). Hosting itself: [Listing media](./MEDIA.md).

## One listing image component

`ListingImage` (`apps/web/src/components/listing/listing-image.tsx`) renders every listing image: the
card logos, the detail page's logo, featured image, and previous/next links, search
suggestions, and the admin, account, and submit previews (`ProductLogo` in
`components/admin/product-cell.tsx` and `components/submit/submit-ui.tsx` wrap it).

- **No image** (no hosted key, or a value that is not an image reference): the server renders the
  #86 tile, `/listing-logos/favicon-fallback-512x512.png`.
- **A load error after hydration:** `onError` swaps in the tile in the same box. Logos have a fixed
  size and featured images a fixed 1200×630 box (shadcn `AspectRatio`), so nothing shifts.
- **A load error before hydration**, when no listener was attached yet: on mount the component
  finds the broken image (`complete`, no natural width, and `decode()` rejects) and swaps it. Until
  then its `::after`, which Chromium and Firefox draw only for a broken image, paints the tile
  over the broken-image icon and the alt text.
- **Alt text, in every engine and without JavaScript:** a broken image draws it in its own
  `color`, which is transparent and clipped (`text-transparent overflow-hidden`), so Safari never
  shows it either. The `alt` attribute stays for assistive technology.

Every listing image carries `data-listing-image="logo|image"`. Guards:

- `scripts/listing-image-guard.test.ts` parses the app and shared UI code and fails on any other
  `<img>`, `next/image`, avatar image, `<picture>`, or HTML string. The few non-listing images
  (badges, guide covers, the email logo) are listed with a reason and may not take listing media.
  It also names every file that renders `ListingImage`.
- `apps/web/e2e/listing-image-fallback.spec.ts` answers every image request but the tile with
  404 and requires every listing image on the home and detail pages to end as the loaded tile;
  with JavaScript off, it requires the `::after` tile on each broken image.
- `scripts/catalog-media.test.ts` requires every published logo and image to be its own listing's
  hosted key (`listings/<slug>/<kind>/`), every manifest to name only such keys or no image, and
  listing content to embed no image, so no other host is ever rendered.

## Media health check

`pnpm media:health -- <staging|production> [--report <file.json>] [--sample <n>]` is read-only:

1. One `SELECT` of every listing logo and image row, through the release tooling's Wrangler D1
   target (`cloudflare-release.ts`, `query` only).
2. The environment's bucket listed under `best.serp.co/listings/` with the R2 list API, 1,000
   objects a call on the uploader's shared rate limiter (`scripts/r2-objects.ts`).
3. `HEAD` requests for a sample of the keys (50 by default, rotated weekly) on the media host, sent
   as `best-serp-co-media-health/1.0` (`MEDIA_HEALTH_USER_AGENT`) with an image `Accept`.

It reports `not_hosted` (a row with no key), `foreign_key`, `missing`, `bytes_mismatch`,
`content_type_mismatch`, `not_an_image`, `cache_control_mismatch`, `md5_mismatch` (against the
reviewed `d1/media` plan), and, from the media host, `cdn_404`, `cdn_not_an_image`,
`cdn_content_type`, or `cdn_bytes`. It writes the JSON report and the job summary, and exits 1
when anything is found.

A HEAD the media host does not answer about the object is **unverifiable**, never a finding: a
403 or 429 (the first production run, #134, met Cloudflare's bot protection on 11 of 50 HEADs
from the GitHub runner while each object answered 200 to a normal client), a `cf-mitigated`
challenge, any other status, or no answer after three tries. The summary lists them by reason, and
warns, without failing the job, when they reach 20% of the sample: the R2 listing already proved
those objects. Since 2026-10-07 a Cloudflare cache rule makes the `/best.serp.co/` paths on
`cdn.serp.co` and `cdn-staging.serp.co` edge-cacheable (before, every response was `DYNAMIC`). It needs `CLOUDFLARE_ACCOUNT_ID`
and a `CLOUDFLARE_API_TOKEN` with D1 → Read and Workers R2 Storage → Read.

A listing with a missing object shows the tile until it is re-hosted: a new logo URL in the admin
listing edit (which queues `media_ingestions`), or a reviewed media plan and manifest. The check
never writes, so it never re-queues anything itself.

### Weekly workflow

`media-health.yml` runs every Monday (and on dispatch) for production: the check, then
`pnpm media:health:issue`, which holds only the job's `GITHUB_TOKEN` (issues: write) and opens one
issue with the findings, updates the open one, or closes it with a comment once the check is
clean. Only an issue `github-actions[bot]` opened counts, so a planted marker is ignored, and the
checkout keeps no token (`persist-credentials: false`) for the step that holds the Cloudflare one. A schedule on `staging` (the default branch) relays to `main`. In the
[credential guards](./RELEASE_GUARDS.md#d1-data-stays-in-cloudflare) the check's exact command is a
token step without D1 changes, so it needs no bookmark; any variant still does.

Owner setup, until which every run is skipped:

1. Create the environment `production-media-health`: deployment branches `main` only, no
   required reviewers (a schedule cannot pass approval). Add `CLOUDFLARE_ACCOUNT_ID` and a
   `CLOUDFLARE_API_TOKEN` with only Account → D1 → Read and Workers R2 Storage → Read.
2. Set the repository variable `MEDIA_HEALTH_CHECK` to `on`.
