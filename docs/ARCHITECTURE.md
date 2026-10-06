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
  -> Cloudflare Worker entry (apps/web/worker.ts): canonical-host and trailing-slash
     redirects, the environment's crawl policy, then the epoch-keyed edge HTML cache
  -> OpenNext / Next.js routes (apps/web), on a cache miss
     -> server-only catalog adapter (apps/web/lib/catalog)
        -> catalog operations (packages/data-ops) -> D1 (DB) public catalog tables
     -> server-only submission adapter (apps/web/lib/submissions)
        -> submission operations (packages/data-ops) -> D1 (DB) private intake tables
     -> server-only account adapter (apps/web/lib/auth): Better Auth, requireUser/requireAdmin
        -> account operations (packages/data-ops/auth) -> D1 (DB) users, sessions, allowlist
```

`/admin` and `/api/admin` pass the Worker entry's Cloudflare Access and session-cookie gate
first ([Accounts](./ACCOUNTS.md)).

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
- `apps/web/worker.ts` is the Worker entry. It wires the build output into the request
  pipeline (`apps/web/lib/worker/handle-request.ts`), which redirects non-canonical hosts
  and URLs (`apps/web/lib/routing/`), applies the environment's crawl policy
  (`apps/web/lib/environment/`), serves anonymous pages from the edge HTML cache
  (`apps/web/lib/edge-cache/`), and otherwise delegates to the generated
  `.open-next/worker.js`. It reads only the catalog epoch, through `packages/data-ops/`.
- `apps/web/lib/catalog/` acquires the binding, validates the runtime environment,
  and deduplicates reads per request. It contains no SQL.
- `apps/web/lib/submissions/` validates the binding, performs bounded badge HTTP
  verification, and delegates every submission write to `packages/data-ops/`.
- `apps/web/lib/email/` sends transactional email through the useSend API after the
  response, claims each template and event key in the `email_deliveries` ledger
  (`packages/data-ops/`) so it never sends twice, and only logs locally
  ([Email](./EMAIL.md)).
- `apps/web/lib/auth/` configures Better Auth (email sign-in codes) on the `DB` binding,
  serves `/api/auth/*`, guards admin routes, and verifies Cloudflare Access JWTs; account SQL
  lives in `packages/data-ops/src/auth.ts` ([Accounts](./ACCOUNTS.md)).
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

## Environments and hosts

Each environment is marked explicitly in the `vars` of `apps/web/wrangler.jsonc` and read
per request (serp `standards/environment-configuration.md`); nothing is inferred from the
host alone. A test (`apps/web/lib/environment/site-environment.test.ts`) pins the values.

| Var | local | staging | production |
| --- | --- | --- | --- |
| `SITE_ENVIRONMENT` | `local` | `staging` | `production` |
| `CANONICAL_HOST_REDIRECT` | unset | unset | `on` since the cutover (`off` before it) |

- **Public production** is `SITE_ENVIRONMENT=production` on the canonical host
  `best.serp.co`: indexable, `robots.txt` lists the sitemap index, and Google Tag Manager
  loads. Everything else is non-production: local, staging, the production Worker's
  `*.workers.dev` host, and a missing or misspelled var. There the Worker entry sends
  `X-Robots-Tag: noindex, nofollow` on every response it answers and answers `/robots.txt`
  with `Disallow: /` for every crawler, and the root layout leaves Google Tag Manager out
  (`apps/web/lib/environment/`). Static files are served before the Worker runs, so
  `apps/web/public/_headers` keeps them `noindex` on every `*.workers.dev` host, and
  `next.config.ts` keeps its `*.workers.dev` `noindex` rule as defense in depth.
- **Canonical host** (#42 decision e). With `CANONICAL_HOST_REDIRECT=on`, the production
  Worker answers every `*.workers.dev` request (the workers.dev URL and preview URLs) with one
  308 to `https://best.serp.co`, in canonical form and with the query kept byte for byte:
  `/about?x=1` -> `https://best.serp.co/about/?x=1`. It runs before the trailing-slash rule
  and the edge cache (`apps/web/lib/routing/canonical-host.ts`), so a stored response never
  answers the wrong client. Requests that carry the `x-best-serp-co-smoke-test` header (any
  value; not a secret) are served normally, so CI can test through the platform host. A
  moved URL keeps its path and gets its own redirect on best.serp.co. Static files on
  `*.workers.dev` are not redirected (they never reach the Worker; they stay `noindex`).
  Staging never redirects. Both deployed environments set `workers_dev: true` and
  `preview_urls: false`.
- **Worker version and gates.** Every Worker response carries `x-worker-version`
  (`CF_VERSION_METADATA.id`) and `x-site-environment` (the configured `SITE_ENVIRONMENT`, or
  `unset`). Given the deployed version (`EXPECTED_WORKER_VERSION`, or the `deploy` entry
  Wrangler writes to `WRANGLER_OUTPUT_FILE_PATH`), the HTTP gates
  (`scripts/d1-preview-http-gates.ts`) wait until it answers three probes in a row (logging
  `Worker version <id> answered N probe(s)`), then require it on every response, retrying an
  answer from the previous version within the same 60-second budget; they assume
  `wrangler deploy` to 100% of traffic. Production is gated on its platform host with the
  smoke-test header (non-production policy, `x-site-environment: production`, and the 308 once
  the switch is `on`), then on best.serp.co itself without it: no noindex, robots.txt lists the
  sitemap index, Google Tag Manager loads. Every answer from the Worker is enforced. Only
  these are skipped, with a `best.serp.co check skipped` warning: a `cf-mitigated` challenge,
  a 403 or 429 without Worker headers (zone protection), and GitHub Pages before the cutover
  (which fails while the switch is `on`). A 503 without Worker headers (for example, a Worker
  over its limits), no answer, or any other answer fails. The workers.dev pass also rejects a
  robots-meta noindex on `/` and a listing page, which is the same on every host. In
  `apps/web/lib/environment/`, `public-policy.test.tsx` runs the policy through the Worker
  pipeline and the root layout's analytics decision, and `noindex-sources.test.ts` checks the
  real `next.config.ts` headers and the layout's and pages' robots metadata.
- **Manual check of best.serp.co** (deploy runbook, cutover step 4, and after any gate run
  that logged `best.serp.co check skipped`). `pnpm tsx scripts/d1-preview-http-gates.ts public
  https://best.serp.co` runs the same best.serp.co checks without skipping anything. Then
  `curl -sI https://best.serp.co/` must show `x-site-environment: production` and an
  `x-worker-version` equal to the version Deploy Production deployed: the id its gate log
  prints (`Worker version <id> answered N probe(s)`), or the active deployment under Workers &
  Pages → `best-serp-co-production` → Deployments in the Cloudflare dashboard.

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
segment ends in a known file extension (`FILE_EXTENSIONS` in
`packages/utils/file-extensions.ts`), not any dot: most listing slugs are domain names
(`autoenhance.ai`), and their pages keep the slash. Never add an extension that is also a
top-level domain. The data side holds the invariant: submission intake
(`packages/data-ops/src/submissions.ts`), the submission approver, and the publication
manifest schema (`scripts/d1-publisher.ts`) refuse a listing slug that ends in one of these
extensions (`chart.js`), and a test checks the committed import.

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
  reaches its page in one hop. Add static moved URLs there (not as a page that calls
  `permanentRedirect()`); `redirects.test.ts` checks that each destination is canonical and
  each source is matched in both slash forms. Redirects that need D1 (renamed listing
  slugs) stay in their pages and must write a canonical destination (`getRoute`). The Worker
  validates the manifest at startup and refuses to start if its shape is unexpected (no
  `redirects` array, a rule without a string `regex`, a pattern that does not compile or
  matches every path), so a framework upgrade cannot silently turn the slash rule off.
  OpenNext re-serializes the query string of config redirects from decoded values, so a
  query that contains an encoded `&`, `=`, `#`, or `+` is not preserved exactly; the pre-D1
  URLs never carried one.
- **Written URLs.** Canonical tags, `og:url`, sitemaps, `robots.txt`, and JSON-LD build
  absolute URLs with `absoluteUrl` (`siteUrl` in `seo-config.ts`), which writes the homepage
  as the bare origin. With `trailingSlash`, the Next.js metadata API appends `/` to every
  same-origin URL, so the homepage leaves `alternates.canonical` and `openGraph.url` unset
  and `apps/web/app/page.tsx` renders both tags with `HomePageCanonicalTags`. Never render
  them in `HomePageRoute`: `/products/` reuses it with its own canonical. JSON-LD node
  identifiers keep their
  fragment form (`https://best.serp.co/#website`); they name a graph node, not the page.
- **Origin.** Sitemaps, canonical tags, and structured data always use the production
  origin from `packages/site-config` (`https://best.serp.co`), also locally and on the
  noindex `*.workers.dev` hosts. This is deliberate: the e2e suite and the HTTP gates then
  verify on staging exactly the URLs production publishes, and those hosts are never
  indexed.
- **Listing images.** A listing without a usable logo renders the checked-in "no logo" tile
  `apps/web/public/listing-logos/favicon-fallback-512x512.png` (source and render notes in
  `scripts/assets/listing-logo-fallback.svg`). The tile is UI only: listing JSON-LD names
  the listing's own logo as `primaryImageOfPage` and omits the property when there is none,
  rather than give every logo-less listing the same image or the SERP logo
  (`packages/web-core/src/schema.ts`). `apps/e2e/tests/listing-logo-assets.spec.ts` checks
  that the Worker serves the tile and that sample pages reference no missing same-origin file.
- **Listing offers.** D1 records no product pricing, so listing JSON-LD carries no `offers`.
  A default `price: "0"` would call every paid product free. `generateWebsiteDetailSchema`
  emits an Offer only for known `pricing` (free: price 0; paid: decimal price and three-letter
  currency code). The submission `plan` is the listing fee, never product pricing
  (serpcompany/best.serp.co#88). `apps/e2e/tests/listing-structured-data.spec.ts` checks that
  rendered listings carry no Offer.
- **Sitemaps.** On best.serp.co, `/robots.txt` advertises `/sitemap-index.xml` (every other
  host serves a disallow-all robots.txt; see [Environments and hosts](#environments-and-hosts)).
  The index lists the URL-set files
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
   still receive the origin `Cache-Control`. A cacheable request reaches OpenNext with only
   `accept`, `host`, `user-agent`, and the router headers; every other request header
   (cookies, `x-nonce`, forwarded and framework-internal headers) is dropped, so nothing a
   client sends can be stored and served to others (`renderRequestFor`). Bypassed: `/api`
   (including `/api/auth`), `/admin`, `/account`, `/login`, `/search`, `/_next` (first path
   segment in any case), requests with `Authorization`, and requests carrying a Better Auth
   (`better-auth.*`) or preview cookie, so a signed-in request is never served from or
   stored in the cache. Responses carry `x-edge-cache: HIT | MISS | BYPASS`.
2. **Epoch memo.** Each isolate reuses its epoch for 30 seconds and revalidates it in the
   background for up to 5 minutes; isolates in one data center share it through the Cache
   API for 30 seconds. D1 therefore sees about one one-row epoch read per data center per
   30 seconds, and a publication reaches cached pages within about a minute. Nothing is
   purged: old keys stop matching and expire. The entry shares the epoch with the renders in
   its isolate (`shareCatalogEpochToken`, a global, never a request header), so a render
   reuses it for up to 30 seconds instead of reading it again.
3. **Data cache** (Workers Cache API, `packages/data-ops/src/cache.ts`). Shell counts,
   name order, name pages, featured/latest heads, details, search results (per normalized
   query and limit), and the full summary list (for sitemaps and the feed) are cached under
   epoch-scoped keys for 24 hours, with live D1 fallback when the cache fails.
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
