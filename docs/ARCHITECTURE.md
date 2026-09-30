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
  -> Cloudflare Worker / Next.js routes (apps/web)
     -> server-only catalog adapter (apps/web/lib/catalog)
        -> catalog operations (packages/data-ops) -> D1 (DB) public catalog tables
     -> server-only submission adapter (apps/web/lib/submissions)
        -> submission operations (packages/data-ops) -> D1 (DB) private intake tables
```

## Responsibility map

- `apps/web/app/` adapts HTTP routes to page behavior. Public URLs:
  `/products/<slug>/reviews/` (detail), `/products/best/<category>/` (category),
  `/products/best/featured/`, `/products/`, `/brands/`, `/search/`, `/submit/`,
  `/legal/*`, `/rss.xml`, `/sitemap-index.xml`, `/sitemaps/{pages,directory,categories}/1.xml`.
  Legacy aliases (`/products/<slug>/`, `/categories/<x>/`) redirect permanently in
  `apps/web/next.config.ts`.
- `apps/web/lib/catalog/` acquires the binding, validates the runtime environment,
  and deduplicates reads per request. It contains no SQL.
- `apps/web/lib/submissions/` validates the binding, performs bounded badge HTTP
  verification, and delegates every submission write to `packages/data-ops/`.
- `packages/site-config/` is the checked-in site definition (name, domain, copy,
  routes, sitemap layout, badges, feature flags) and site-owned content.
- `packages/web-core/` owns reusable page/view behavior and reads the site definition
  through `siteConfig`; it never obtains a database binding.
- `packages/data-ops/` owns the Drizzle schema, the injected D1 client, catalog DTOs,
  eligibility SQL, pagination, redirects, related ranking, adjacency, the
  publication-versioned data cache, query telemetry, and all submission operations.
  It receives the database, clock, cache, and observer explicitly.
- `d1/drizzle/` owns the migration history applied by Wrangler.
- `d1/publications/` owns reviewed catalog mutations.
- `scripts/d1-submission-approver.ts`, `scripts/d1-submission-notifier.ts`, and the
  publishers consume credential-free statement plans from `packages/data-ops/`; they
  are the only layer that acquires credentials or calls remote APIs.
- `scripts/migration/` holds the one-time JSON import and page comparison tooling. It
  is never imported by runtime or build code.

## Caching

Three separate mechanisms:

1. React `cache()` deduplicates reads within a request.
2. The Workers Cache API stores catalog summaries, details, and shell counts keyed by
   the current `publication_state.version`, so a publication invalidates immediately.
   Each request still reads the one-row publication version.
3. Full-page HTTP caching is not enabled yet (see serpcompany/best.serp.co#34, Phase 3).

## Trust direction

```text
untrusted request / environment / migration source
  -> boundary parser
     -> precise application representation
        -> repository or release operation
           -> local D1 or protected remote workflow
```

Client code never imports the catalog repository. Local tools cannot select staging
or production resources, and a passing local harness does not authorize a remote
operation.

Conditional badge verification, rejection, and approval plans place a `changes()`
assertion after every compare-and-swap transition in the same batch, so a stale
status, publication version, or checksum rolls the whole batch back.

`drizzle.config.ts` is credential-free: it generates reviewable SQL in `d1/drizzle/`;
Wrangler owns migration application and the `d1_migrations` ledger.
