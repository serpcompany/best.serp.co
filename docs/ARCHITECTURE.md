# Architecture

best.serp.co is one Next.js application (`apps/web`) built by `@opennextjs/cloudflare`
and deployed as a Cloudflare Worker. Each environment (local, staging, production) has
its own D1 database bound as `DB`.

Server components and route handlers call the server-only catalog adapter. The adapter
validates the binding and `D1_RUNTIME_ENV`, then constructs the shared
`@serpdirectory/data-ops` operations, which run prepared SQL and map rows into summary
and detail DTOs. There is no filesystem fallback.

```text
Browser
  -> Cloudflare Worker entry (apps/web/worker.ts): trailing-slash redirects,
     then the epoch-keyed edge HTML cache
  -> OpenNext / Next.js routes (apps/web), on a cache miss
     -> server-only catalog adapter (apps/web/lib/catalog)
        -> catalog operations (packages/data-ops) -> D1 (DB) public catalog tables
     -> server-only submission adapter (apps/web/lib/submissions)
        -> submission operations (packages/data-ops) -> D1 (DB) private intake tables
```

## Responsibility map

- `apps/web/app/` adapts HTTP routes to page behavior. Public URLs:
  `/products/<slug>/` (detail), `/products/categories/` (index),
  `/products/categories/<category>/` (category), `/products/`, `/brands/`, `/search/`,
  `/submit/`, `/legal/*`, `/rss.xml`, `/sitemap-index.xml`,
  `/sitemaps/{pages,directory,categories}/1.xml`. The pre-D1 scheme
  (`/products/<slug>/reviews/`, `/products/best/<category>/`, `/categories/<x>/`) redirects
  permanently through `apps/web/next.config.ts` (rules in `apps/web/lib/routing/redirects.ts`).
  "Featured" is a listing flag used for placements (the homepage section), not a public
  category page.
- `apps/web/worker.ts` is the Worker entry: it redirects non-canonical page and file URLs
  (`apps/web/lib/routing/`), serves anonymous pages from the edge HTML cache
  (`apps/web/lib/edge-cache/`), and otherwise delegates to the generated
  `.open-next/worker.js`. It reads only the catalog epoch, through `packages/data-ops/`.
- `apps/web/lib/catalog/` acquires the binding, validates the runtime environment,
  and deduplicates reads per request. It contains no SQL.
- `apps/web/lib/submissions/` validates the binding, performs bounded badge HTTP
  verification, and delegates every submission write to `packages/data-ops/`.
- `packages/site-config/` is the checked-in site definition (name, domain, copy,
  routes, sitemap layout, badges, feature flags) and site-owned content.
- `packages/web-core/` owns reusable page/view behavior and reads the site definition
  through `siteConfig`; it never obtains a database binding.
- `packages/data-ops/` owns the Drizzle schema, the injected D1 client, catalog DTOs,
  eligibility SQL, pagination, redirects, related ranking, adjacency, the catalog
  epoch and the epoch-keyed data cache, query telemetry, and all submission operations.
  It receives the database, clock, cache, and observer explicitly.
- `d1/drizzle/` owns the migration history applied by Wrangler.
- `d1/publications/` owns reviewed catalog mutations.
- `scripts/d1-submission-approver.ts`, `scripts/d1-submission-notifier.ts`, and the
  publishers consume credential-free statement plans from `packages/data-ops/`; they
  are the only layer that acquires credentials or calls remote APIs.
- `scripts/migration/` holds the one-time JSON import and page comparison tooling. It
  is never imported by runtime or build code.

## URL canonicalization

Every URL has one canonical form, per the SERP URL trailing-slash and sitemap standards
(serpcompany/serp `docs/engineering/standards/url-trailing-slash.md` and
`docs/engineering/websites/features/xml-sitemaps.md`):

| URL | Canonical form | Non-canonical request |
| --- | --- | --- |
| Homepage | `https://best.serp.co` (written without a slash) | none: `/` is the only path |
| Page | ends with `/`: `/about/`, `/products/autoenhance.ai/` | `/about` -> 308 `/about/` |
| File | never ends with `/`: `/robots.txt`, `/sitemaps/pages/1.xml` | `/robots.txt/` -> 308 `/robots.txt` |
| `/api`, `/api/*`, `/.well-known/*`, `/_next/*` | served exactly as requested | never redirected |

`packages/web-core/src/canonical-url.ts` defines the rule. A file is a path whose last
segment ends in a known file extension (`FILE_EXTENSIONS`), not any dot: most listing slugs
are domain names (`autoenhance.ai`), and their pages keep the slash. Never add an extension
that is also a top-level domain.

- **Redirects.** The Worker entry answers a non-canonical request with one 308 before the
  edge cache and before OpenNext (`apps/web/lib/routing/trailing-slash.ts`), so slash
  variants are never rendered or cached. The `Location` is relative and keeps the query
  string byte for byte. `skipTrailingSlashRedirect` (in `configs/next`) keeps the framework's
  own slash redirect off: it differs between Next.js and OpenNext and has no `/api`
  exception. OpenNext Node middleware is not used (it is experimental on Cloudflare).
- **Moved URLs.** `apps/web/lib/routing/redirects.ts` lists them and `next.config.ts`
  applies them. Next.js matches each source with or without a slash and every destination
  is canonical, so the Worker leaves any request a moved-URL rule matches to OpenNext (it
  reads the same compiled patterns from `.next/routes-manifest.json`), and the request
  reaches its page in one hop. Add new moved URLs there; `redirects.test.ts` checks that
  each destination is canonical and each source is matched in both slash forms. OpenNext
  re-serializes the query string of these redirects from decoded values, so a query that
  contains an encoded `&`, `=`, `#`, or `+` is not preserved exactly; the pre-D1 URLs never
  carried one.
- **Written URLs.** Canonical tags, `og:url`, sitemaps, `robots.txt`, and JSON-LD build
  absolute URLs with `absoluteUrl` (`siteUrl` in `seo-config.ts`), which writes the homepage
  as the bare origin. With `trailingSlash`, the Next.js metadata API appends `/` to every
  same-origin URL, so the homepage leaves `alternates.canonical` and `openGraph.url` unset
  and renders both tags itself (`HomePageRoute`). JSON-LD node identifiers keep their
  fragment form (`https://best.serp.co/#website`); they name a graph node, not the page.
- **Origin.** Sitemaps, canonical tags, and structured data always use the production
  origin from `packages/site-config` (`https://best.serp.co`), also locally and on the
  noindex `*.workers.dev` hosts. This is deliberate: the e2e suite and the HTTP gates then
  verify on staging exactly the URLs production publishes, and those hosts are never
  indexed.
- **Sitemaps.** `/robots.txt` advertises `/sitemap-index.xml`, which lists the URL-set files
  `/sitemaps/pages/1.xml`, `/sitemaps/directory/1.xml`, and `/sitemaps/categories/1.xml`
  directly (no nested index). `/sitemap.xml` is a compatibility redirect to the index.
  Listing entries carry `published_at` as `lastmod`; the static page and category sets carry
  the generation time.

The Playwright smoke suite (staging) and `scripts/d1-preview-http-gates.ts` (staging and
production) assert the redirects, the `/api` exemption, and the homepage form.

## Pagination

The directory (`/`, `/products/`) and category pages show 48 listings per page in
directory order (publication order, then a stable locale sort by name, as the pages
always rendered). Later pages use a `?page=N` query parameter on the existing URL:
`/products/?page=2`, `/products/categories/other/?page=3`. The homepage shows page 1 and
links into `/products/?page=N`. Page 1 is the bare URL, so URLs, canonicals, sitemaps,
and structured data are unchanged; pages 2+ are linked with plain `<a href>` anchors,
canonicalize to themselves, carry `noindex, follow` and a "- Page N" title, and a page
past the end is a 404. Category JSON-LD describes the whole category on every page.
`packages/web-core/src/listing-pagination.tsx` owns the parameter, links, and metadata;
`getListingNamePage` in `packages/data-ops` reads one page (ids in name order are cached
per epoch, then only that page's summaries are read). Routes never load the full catalog
for display; only the sitemaps and the JSON feed read every listing.

## Caching

Public content changes only with the **catalog epoch**: `publication_state.version` plus
the newest `published_at` that is already public (so a listing scheduled for the future
appears when it becomes due, without a publication). `packages/data-ops/src/catalog-epoch.ts`
reads it with one statement (two index seeks). Four layers, from the edge inward:

1. **Edge HTML cache** (`apps/web/worker.ts`, logic in `apps/web/lib/edge-cache/`). The
   Worker entry wraps the OpenNext handler. Anonymous `GET`/`HEAD` requests are served from
   the Workers Cache API under a key of Worker version (`CF_VERSION_METADATA`), catalog
   epoch, host, path and query (and, for React Server Components requests, the router
   headers Next.js varies on). A hit loads neither Next.js nor D1. Misses render normally
   and 200/301/308/404 responses without `Set-Cookie` are stored for 24 hours; visitors
   still receive the origin `Cache-Control`. Bypassed: `/api`, `/admin`, `/account`,
   `/login`, `/search`, `/_next`, requests with `Authorization`, and Auth.js or preview
   cookies. Responses carry `x-edge-cache: HIT | MISS | BYPASS`.
2. **Epoch memo.** Each isolate reuses its epoch for 30 seconds and revalidates it in the
   background for up to 5 minutes; isolates in one data center share it through the Cache
   API for 30 seconds. D1 therefore sees about one one-row epoch read per data center per
   30 seconds, and a publication reaches cached pages within about a minute. Nothing is
   purged: old keys stop matching and expire.
3. **Data cache** (Workers Cache API, `packages/data-ops/src/cache.ts`). Shell counts,
   name order, name pages, featured/latest heads, details, and the full summary list (for
   sitemaps and the feed) are cached under epoch-scoped keys for 24 hours, with live D1
   fallback when the cache fails.
4. React `cache()` deduplicates reads within a request.

Both Cache API layers are per data center and populate on demand. A deployment gets a new
Worker version and therefore a cold HTML cache; the data cache survives deployments.

Alternatives evaluated for @opennextjs/cloudflare 1.20.6 / Next 16.3.6
(serpcompany/best.serp.co#34): OpenNext ISR with the R2 incremental cache would need every
page made static (the layout reads the session, and build-time prerendering would bake the
build machine's D1 into the bundle), a Durable Object queue for revalidation, and a tag
cache (D1 or Durable Objects) consulted on every request, plus a revalidation hook in the
out-of-Worker publish workflows. Cache interception only applies to ISR/SSG routes, the KV
incremental cache is eventually consistent and not recommended by OpenNext, and the KV tag
cache is marked experimental. The epoch-keyed Cache API wrapper uses only the documented
custom-Worker entry and needs no new Cloudflare resources. Cloudflare's newer Workers
Caching (a cache in front of the Worker with request collapsing and tiered cache) could
replace layer 1 later, but it bills every static asset request and needs a purge trigger
the out-of-Worker publish flow cannot send today.

## Trust direction

```text
untrusted request / environment / migration source
  -> boundary parser
     -> precise application representation
        -> repository or release operation
           -> local D1 or protected remote workflow
```

Client code never imports the catalog repository. Local tools cannot change staging or
production resources: `scripts/cloudflare-release.ts` allows only its read-only checks
outside the protected workflows, and a passing local harness does not authorize a remote
operation.

Conditional badge verification, rejection, and approval plans place a `changes()`
assertion after every compare-and-swap transition in the same batch, so a stale
status, publication version, or checksum rolls the whole batch back.

`drizzle.config.ts` is credential-free: it generates reviewable SQL in `d1/drizzle/`;
Wrangler owns migration application and the `d1_migrations` ledger.
