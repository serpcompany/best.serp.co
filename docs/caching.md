# Caching

How public pages stay fast without serving stale content: four cache layers, of which the edge
HTML cache and the data cache are keyed by the catalog epoch, so a publication reaches every page
without a purge. The Worker entry that runs the first layer is in
[Architecture](./architecture.md); what a publication changes is in [Data model](./data-model.md).

## The catalog epoch

Public content changes only with the **catalog epoch**: `publication_state.version` plus
the newest `published_at` that is already public (so a listing scheduled for the future
appears when it becomes due, without a publication). `apps/web/src/db/catalog-epoch.ts`
reads it with one statement (two index seeks).

## The four layers

From the edge inward:

1. **Edge HTML cache** (`apps/web/worker.ts`, logic in `apps/web/src/lib/edge-cache/`). The
   Worker entry wraps the OpenNext handler. Anonymous `GET`/`HEAD` requests are served from
   the Workers Cache API under a key of Worker version (`CF_VERSION_METADATA`), catalog
   epoch, host, path and query (and, for React Server Components requests, the router
   headers Next.js varies on). A hit loads neither Next.js nor D1. Misses render normally
   and 200/301/308/404/410 responses without `Set-Cookie` are stored for 24 hours; visitors
   still receive the origin `Cache-Control`. A cacheable request reaches OpenNext with only
   `accept`, `host`, `user-agent`, and the router headers; every other request header
   (cookies, `x-nonce`, forwarded and framework-internal headers) is dropped, so nothing a
   client sends can be stored and served to others (`renderRequestFor`). Personalized,
   private, mutable and free-form paths are bypassed by their first segment, in any case
   (`BYPASS_PATH_SEGMENTS`), and so are requests with `Authorization` and requests carrying a
   Better Auth (`better-auth.*`) or preview cookie, so a signed-in request is never served from
   or stored in the cache. Responses carry `x-edge-cache: HIT | MISS | BYPASS`. The Worker
   adds the environment headers (`X-Robots-Tag`, `x-site-environment`, `x-worker-version`)
   after this layer, from each request, so a stored response carries none of them.
   **Staging's password** (#359, [Architecture](./architecture.md#environments-and-hosts)) is
   checked before this layer: a request without it gets a 401 that is never stored and never
   reaches a stored page, and a request with it continues without its `Authorization` header,
   so it is cached like an anonymous one. A staging page renders the same on both sides of the
   password (its URLs come from the environment, not the request), and only the header added
   afterwards differs: no `X-Robots-Tag` with the password, `noindex` for a smoke-test request
   served the same entry. `handle-request.test.ts` checks every order of these visitors.
2. **Epoch memo.** Each isolate reuses its epoch for 30 seconds and revalidates it in the
   background for up to 5 minutes; isolates in one data center share it through the Cache
   API for 30 seconds. D1 therefore sees about one one-row epoch read per data center per
   30 seconds, and a publication reaches cached pages within about a minute. Nothing is
   purged: old keys stop matching and expire. The entry shares the epoch with the renders in
   its isolate (`shareCatalogEpochToken`, a global, never a request header), so a render
   reuses it for up to 30 seconds instead of reading it again.
3. **Data cache** (Workers Cache API, `apps/web/src/db/cache.ts`). Shell counts,
   name order, name pages, featured/latest heads, details, search results (per normalized
   query and limit), and the full summary list (for sitemaps and the feed) are cached under
   epoch-scoped keys for 24 hours, with live D1 fallback when the cache fails.
4. React `cache()` deduplicates reads within a request.

Both Cache API layers are per data center and populate on demand. A deployment gets a new
Worker version and therefore a cold HTML cache; the data cache survives deployments. Confirming
it after a deploy is in the [Deploy runbook](./deploy-runbook.md#after-a-deploy).

## Why this design

Alternatives evaluated for @opennextjs/cloudflare 1.20.6 / Next 16.3.6: OpenNext ISR with the R2
incremental cache would need static pages, a Durable Object revalidation queue, and a per-request
tag cache; KV caches are eventually consistent or experimental. The epoch-keyed wrapper needs no
new resources. Cloudflare's Workers Caching could replace layer 1 later, but it bills every static
asset request and needs a purge trigger the out-of-Worker publish flow cannot send today.
