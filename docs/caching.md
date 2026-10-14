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
   or stored in the cache. The taxonomy's pages (`/products/tags/`, `/best/`, #346) are cached
   like any catalog page, and so is the 308 of a moved category, tag or best page URL: the
   publication that moves it changes the epoch. Responses carry
   `x-edge-cache: HIT | MISS | BYPASS`. The Worker adds the environment headers (`X-Robots-Tag`,
   `x-site-environment`, `x-worker-version`) after this layer, from each request, so a stored
   response carries none of them.
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
   purged: old keys stop matching and expire.
   Requests share only the settled epoch, never a load in flight (#443). Workers runs a load's
   I/O in the request that started it and drops it when that request ends, so a shared load
   once left every cached page on an isolate waiting for hours. Each load is the calling
   request's own, through its own cache handle and logger, and nothing before the render waits
   unbounded:
   - a request waits at most 2 seconds for its epoch (`EPOCH_LOAD_TIMEOUT_MS`); then, or when
     the load fails, it uses the isolate's last epoch at any age, or bypasses the cache if there
     is none. A load it stopped waiting for runs on in its own request's `waitUntil`, so a slow
     D1 answer still updates the memo and the share;
   - the load reads the data center's share for at most 1 second before it reads D1, and stores
     the share in the background;
   - a page lookup slower than 1 second (`CACHE_MATCH_TIMEOUT_MS`) renders as a miss.

   A refresh, or a load its request stopped waiting for, runs for at most 25 seconds
   (`EPOCH_REFRESH_TIMEOUT_MS`), under `waitUntil`'s 30. A stale epoch's background refresh holds
   its claim until it answers, fails or reaches that bound (#445), so an isolate runs one at a
   time however slow D1 is, and a busy isolate starts about one per 30 seconds plus the read's
   time. A refresh whose request ended never releases its claim; it lapses after 25 seconds, and
   the next stale request refreshes again.
   A load started earlier never replaces an epoch a later one stored, and only a
   load the memo stores shares its token with other renders. The epoch travels with the D1 bookmark of the
   read that returned it, in the memo and in the share (beside the bare token, in an
   `x-d1-bookmark` header; see [Read replication](#read-replication)). The render of a miss gets
   both for its own request (`runWithCatalogRead`, an async context like OpenNext's, never a
   global or a request header), so it keys the data cache on its edge key's epoch without
   reading it again. Other renders reuse the isolate's last epoch (`shareCatalogEpochToken`, a
   global) for up to 30 seconds.
3. **Data cache** (Workers Cache API, `apps/web/src/db/cache.ts`). Shell counts, tag counts,
   the best index, name order and name pages (keyed by scope: `*`, `c:<category>` or
   `t:<tag>`, so a tag and a category with one slug never share an entry), a best page's
   entries (with each entry's tags, #346: an entry cached without them is read again),
   featured/latest heads, details, search results (per normalized query and limit), and the
   full summary list (for sitemaps and the feed) are cached under epoch-scoped keys for
   24 hours, with live D1 fallback when the cache fails. The redirect lookups (renamed listing
   slugs, moved taxonomy URLs, root-level URLs) are single seeks and stay uncached; whether a
   moved URL's target renders comes from the cached shell stats, tag stats and best index. Each
   listing body's parsed Markdown is cached too (`getDerivedValue`, built by
   `lib/markdown/listing-content-tree.ts`, #334): the page renders the cached tree instead of
   parsing the body on every uncached render. A tree's JSON is about twice its body for prose
   and up to about 9 times for markup-dense Markdown (19 KB on average for 10.8 KB bodies, 39 KB
   at most for a 21 KB one), far below the Cache API's object limit. Its key also names the
   tree's format (`LISTING_CONTENT_FORMAT`), which a change to the parser's output must bump,
   because the data cache survives deployments.
4. React `cache()` deduplicates reads within a request.

**Logs.** The edge cache logs one `edge_cache` event per request: `HIT`, `MISS` or `BYPASS`, with
the status. A cacheable request's event carries `epochMs`, `epochSource` (`fresh`, `stale`,
`shared`, `d1`, `timeout` or `error`) and `matchMs`. A step that fails or times out logs one
more as it happens: `epoch-timeout` (with `epochAgeMs`, the age of the epoch it fell back on),
`epoch-error`, `match-timeout` or `store-error`. A client disconnect is not logged: that needs
the `enable_request_signal` compatibility flag, which would also pass the disconnect to every
render.

**Environments never share an entry** (#397). The Cache API works on the zone's cache, and
staging (`staging.best.serp.co`) and production (`best.serp.co`) are custom domains in one zone
(`serp.co`), so in a data center both Workers read and write one cache. Every key tells them
apart: an edge HTML key names the host and Worker version, and the shared epoch's key
(`https://html-cache.invalid/catalog-epoch/<environment>`) and every data-cache key
(`https://catalog-data-ops.invalid/<environment>/<key>`) name the environment,
`D1_RUNTIME_ENV`, which each request validates. There is no unscoped fallback: without a valid
environment the edge cache is bypassed and catalog reads fail closed. Cloudflare doesn't document
whether the caches `caches.open(name)` returns are split per Worker; the environment-scoped keys
don't depend on it.

Both Cache API layers are per data center and populate on demand. A deployment gets a new
Worker version and therefore a cold HTML cache; the data cache survives deployments. Confirming
it after a deploy is in the [Deploy runbook](./deploy-runbook.md#after-a-deploy).

## Read replication

D1 read replication is a setting on each database, off until the owner enables it (#382). It adds
read-only copies in other regions, which only reads through the Sessions API use; the binding
itself always reads the primary.

- **Only public catalog reads for an edge cache miss use a session:** the Worker entry's epoch
  read (`withSession('first-primary')`, `lib/worker/catalog.ts`) and the render of the miss
  (`withSession(<bookmark>)`, `lib/catalog/repository.ts`). Writes, the admin panel, accounts,
  submissions, claims, billing, auth, the cron jobs, the entry's redirect and gone-listing seeks,
  and every bypassed render (signed in, `/search`, `/api`) read the primary;
  `architecture-guard.test.ts` keeps `withSession(` to those two files.
- **A render never reads rows older than the epoch it keys the caches on.** Its session starts at
  the bookmark of the read that returned that epoch, and D1 answers each statement from a copy at
  least that new: a replica behind the bookmark waits until it has caught up. Rows newer than the
  epoch can be read, as without replicas when a publication lands mid-render, and the next epoch
  replaces them.
- **Every epoch is the primary's:** its read starts on the primary, so a publication reaches pages
  as fast as before, and a bypassed render, which reuses the isolate's epoch for the data cache,
  never keys it on a lagging replica's older one (#382 review). The nearest replica answers a
  render at the epoch read's bookmark; only a render in the moments after an epoch read (once per
  data center per 30 seconds) can find it still behind and wait for its lag. An epoch shared
  without a bookmark renders from the primary: under the environment-scoped key (#397), only a
  Worker version with #397 but not #382 stores one, and older versions' unscoped entries are never
  read.
- **Without replication** every statement runs on the primary: the same rows, round trips (the
  epoch read, then one batch per uncached listing) and latency as through the binding.
- **Telemetry:** `d1_query` events carry `servedByPrimary` and `servedByRegion` where remote D1
  reports them. `read-replication.test.ts` runs the path against a lagging replica
  (`ReplicatedD1`), and the workerd suite runs the catalog through a real session.

## Why this design

Alternatives evaluated for @opennextjs/cloudflare 1.20.6 / Next 16.3.6: OpenNext ISR with the R2
incremental cache would need static pages, a Durable Object revalidation queue, and a per-request
tag cache; KV caches are eventually consistent or experimental. The epoch-keyed wrapper needs no
new resources. Cloudflare's Workers Caching could replace layer 1 later, but it bills every static
asset request and needs a purge trigger the out-of-Worker publish flow cannot send today.
