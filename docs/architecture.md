# Architecture

best.serp.co is one Next.js application (`apps/web`) built by `@opennextjs/cloudflare`
and deployed as a Cloudflare Worker. Each environment (local, staging, production) has
its own D1 database bound as `DB`.

Server components and route handlers call the server-only catalog adapter. The adapter
validates the binding and `D1_RUNTIME_ENV`, then constructs the shared
`@/db` operations, which run prepared SQL and map rows into summary
and detail DTOs. There is no filesystem fallback.

```text
Browser
  -> Cloudflare Worker entry (apps/web/worker.ts): canonical-host, old root-level URL, and
     trailing-slash redirects, the crawl policy, then the epoch-keyed edge HTML cache
  -> OpenNext / Next.js routes (apps/web), on a cache miss
     -> server-only catalog adapter (apps/web/src/lib/catalog)
        -> catalog operations (apps/web/src/db) -> D1 (DB) public catalog tables
     -> server-only submission adapter (apps/web/src/lib/submissions)
        -> submission operations (apps/web/src/db) -> D1 (DB) private intake tables
     -> server-only account adapter (apps/web/src/lib/auth): Better Auth, requireUser/requireAdmin
        -> account operations (apps/web/src/db/auth) -> D1 (DB) users, sessions, allowlist
     -> server-only admin adapter (apps/web/src/lib/admin), /admin and /api/admin only
        -> admin reads and statement plans (apps/web/src/db) -> D1 (DB), production included
```

`/admin` and `/api/admin` pass the Worker entry's Cloudflare Access and session-cookie gate
first ([Accounts](./accounts.md)). The admin panel is the one place the app writes production
D1 ([Admin panel](./admin-panel.md#the-production-write-exception)); every other production
change runs in a protected workflow.

## Responsibility map

- `apps/web/src/app/` adapts HTTP routes to page behavior. The route registry
  (`apps/web/src/lib/site/site-routes.ts`) and `getRoute` hold the public URLs; [URLs](./urls.md)
  covers their canonical form and the redirects of older URL schemes. "Featured" is a listing
  flag for placements (the homepage section), not a category page.
- `apps/web/worker.ts` is the Worker entry. It wires the build output into the request pipeline
  (`apps/web/src/lib/worker/handle-request.ts`), which redirects non-canonical hosts and URLs
  (`apps/web/src/lib/routing/`), applies the crawl policy (`apps/web/src/lib/environment/`), serves
  anonymous pages from the edge HTML cache (`apps/web/src/lib/edge-cache/`), and otherwise
  delegates to the generated `.open-next/worker.js`. It reads only the catalog epoch, where an
  unrouted `/<slug>` moved (`lib/routing/legacy-root.ts`), and, after a listing page rendered
  404, whether that slug is unpublished (`lib/routing/gone-listing.ts`: the page is rendered
  again as the 410 gone page), all through `apps/web/src/db/`.
  Its `scheduled()` handler runs `lib/worker/scheduled.ts`, which maps each Cron Trigger to its
  jobs: [draft reminders](./submission-flow.md#draft-reminders-and-expiry) and the
  [billing sweep](./billing.md) (hourly), and the [badge program](./badge-program.md).
- `apps/web/src/lib/catalog/` acquires the binding, validates the runtime environment,
  and deduplicates reads per request. It contains no SQL.
- `apps/web/src/lib/submissions/` validates the binding, fetches submitters' pages and images
  only through its bounded safe fetcher (badge checks, URL prefill, logo checks), and
  delegates every submission read and write to `apps/web/src/db/`, scoped to the owner.
  `apps/web/src/lib/claims/` does the same for [claims](./claims.md).
- `apps/web/src/lib/email/` sends transactional email through the useSend API after the
  response, claims each template and event key in the `email_deliveries` ledger
  (`apps/web/src/db/`) so it never sends twice, and only logs locally
  ([Email](./email.md)).
- `apps/web/src/lib/admin/` validates the binding for the admin panel, parses `/api/admin/*`
  bodies, and runs each decision as reviewed plans from `apps/web/src/db/` (no SQL here).
- `apps/web/src/lib/auth/` configures Better Auth (email sign-in codes) on the `DB` binding,
  serves `/api/auth/*`, guards admin routes, and verifies Cloudflare Access JWTs; account SQL
  lives in `apps/web/src/db/auth.ts` ([Accounts](./accounts.md)).
- `apps/web/src/lib/site/` is the checked-in site definition (name, domain, copy, routes,
  badges, feature flags, the route registry); `apps/web/content/` holds the MDX content.
- `src/components/`, `src/hooks/`, and `src/lib/{seo,site,directory,analytics,routing}/`
  hold the page and view building blocks; they read the site definition through `siteConfig`
  and never obtain a database binding.
- `apps/web/src/db/` owns the Drizzle schema, the injected D1 client, catalog DTOs,
  eligibility SQL, pagination, redirects, related ranking, adjacency, the catalog
  epoch and the epoch-keyed data cache, query telemetry, and all submission operations.
  It receives the database, clock, cache, and observer explicitly.
- `apps/web/drizzle/` owns the migration history applied by Wrangler.
- `d1/publications/` owns reviewed catalog mutations.
- The publishers in `scripts/` consume credential-free statement plans from
  `apps/web/src/db/`; they are the only layer that acquires credentials or calls remote
  APIs.
- `.archive/` holds retired history (#315): the one-time JSON import, its tooling, and the
  production D1 bootstrap. Nothing builds, lints, tests, or runs it.

## Environments and hosts

Each environment is marked explicitly in the `vars` of `apps/web/wrangler.jsonc` and read
per request (serp `standards/environment-configuration.md`); nothing is inferred from the
host alone. A test (`apps/web/src/lib/environment/site-environment.test.ts`) pins the values.

| Var | local | staging | production |
| --- | --- | --- | --- |
| `SITE_ENVIRONMENT` | `local` | `staging` | `production` |
| `CANONICAL_HOST_REDIRECT` | unset | `on` since #323 | `on` since the cutover (`off` before it) |
| `STAGING_BASIC_AUTH_PASSWORD` | unset | `stagingpassword` since #359 | unset |

- **Public production** is `SITE_ENVIRONMENT=production` on the canonical host
  `best.serp.co`: indexable, `robots.txt` lists the sitemap index, and analytics load. Everything
  else is non-production: local, staging, the production Worker's
  `*.workers.dev` host, and a missing or misspelled var. There the Worker entry sends
  `X-Robots-Tag: noindex, nofollow` on every response it answers and answers `/robots.txt`
  with `Disallow: /` for every crawler, and the root layout leaves analytics out
  (`apps/web/src/lib/environment/`). The one exception is a staging request that passed
  staging's password (below). Static files are served before the Worker runs, so
  `apps/web/public/_headers` keeps them `noindex` on every `*.workers.dev` host and on
  `staging.best.serp.co`, and `next.config.ts` keeps its `*.workers.dev` `noindex` rule as
  defense in depth.
- **Staging's password** (#359; serp's `docs/engineering/standards/staging-access.md`, proposed
  in serpcompany/serp#1458). Staging sits behind HTTP Basic auth, so it can describe itself exactly as production will and
  SEO auditors (Ahrefs project 10510472) crawl it as search engines will crawl best.serp.co.
  - **Credentials:** username `staging`, password `stagingpassword`. The password is
    `STAGING_BASIC_AUTH_PASSWORD` in `env.staging.vars` of `apps/web/wrangler.jsonc`, a plain
    var, not a secret: the owner's decision, because every SERP site shares it, serp's standard
    states it, and staging's content is the public site's. The gate checks only the password
    and ignores the username (Ahrefs needs one; use `staging`).
  - **The gate** (`apps/web/src/lib/environment/staging-access.ts`) runs in the Worker entry
    right after the canonical-host redirect, on every host of a Worker that serves as staging
    (`servesAsStaging`: `SITE_ENVIRONMENT=staging`). Without the password a request gets 401
    with `WWW-Authenticate: Basic realm="best.serp.co staging"` and `Cache-Control: no-store`.
    It fails closed: without the var, every request is refused but the exemptions. The
    comparison hashes both values with SHA-256 and compares the digests in constant time.
    Production and local have no gate.
  - **Exemptions**, served without the password and kept `noindex`: requests with the
    `x-best-serp-co-smoke-test` header (CI's gates and smoke), `GET`/`HEAD /robots.txt`, and
    the billing provider's test-mode webhook (`POST /api/billing/webhook/`), which proves
    itself with its signature ([Billing](./billing.md)).
  - **With the password**, a request goes on without its `Authorization` header (so the edge
    cache stores it like an anonymous one) and gets no environment `X-Robots-Tag`; a page's own
    noindex stays, as on best.serp.co. Analytics stay off. Every absolute URL staging writes
    names `https://staging.best.serp.co` ([URLs](./urls.md#written-urls)).
  - **robots.txt** on staging disallows every crawler except `AhrefsSiteAudit`, which gets
    best.serp.co's rules (`crawlRules` in `apps/web/src/lib/site/site-routes.ts`) and staging's
    sitemap index.
  - **Locally**, the e2e suite runs one Worker with `LOCAL_STAGING_ACCESS=on` and a test
    password (`apps/web/e2e/staging-access-fixture.ts`); the switch is ignored anywhere but
    local.
- **Canonical host.** With `CANONICAL_HOST_REDIRECT=on`, a deployed Worker answers every
  `*.workers.dev` request (the workers.dev URL and preview URLs) with one 308 to its own
  canonical host, in canonical form and with the query kept byte for byte: production to
  `https://best.serp.co` (`/about?x=1` -> `https://best.serp.co/about/?x=1`), staging to
  `https://staging.best.serp.co` (#323). It runs before the trailing-slash rule
  and the edge cache (`apps/web/src/lib/routing/canonical-host.ts`), so a stored response never
  answers the wrong client. Requests that carry the `x-best-serp-co-smoke-test` header (any
  value; not a secret) are served normally, so CI can test through the platform host. A
  moved URL keeps its path and gets its own redirect on the canonical host. Static files on
  `*.workers.dev` are not redirected (they never reach the Worker; they stay `noindex`).
  Local never redirects. Both deployed environments set `workers_dev: true` and
  `preview_urls: false`; staging declares `staging.best.serp.co` as a Custom Domain in
  `env.staging.routes`, and production's best.serp.co is attached in the dashboard until
  #192. `scripts/cloudflare-release.ts` refuses a route to any other host.
- **Worker version and gates.** Every Worker response carries `x-worker-version`
  (`CF_VERSION_METADATA.id`) and `x-site-environment` (the configured `SITE_ENVIRONMENT`, or
  `unset`). Given the deployed version (`EXPECTED_WORKER_VERSION`, or the `deploy` entry
  Wrangler writes to `WRANGLER_OUTPUT_FILE_PATH`), the HTTP gates
  (`scripts/d1-preview-http-gates.ts`) wait until it answers three probes in a row (logging
  `Worker version <id> answered N probe(s)`), then require it on every response, retrying an
  answer from the previous version within the same 60-second budget; they assume
  `wrangler deploy` to 100% of traffic. Staging is gated the same way on its platform host
  (`staging https://staging.best.serp.co` goes through workers.dev with the smoke-test header,
  then requires the 308 to staging.best.serp.co without it), and the Playwright smoke runs
  there with the header. Production is gated on its platform host with the
  smoke-test header (non-production policy, `x-site-environment: production`, and the 308 once
  the switch is `on`), then on best.serp.co itself without it: no noindex, robots.txt lists the
  sitemap index, Google Tag Manager loads. Every answer from the Worker is enforced. Only
  these are skipped, with a `best.serp.co check skipped` warning: a `cf-mitigated` challenge,
  a 403 or 429 without Worker headers (zone protection), and GitHub Pages before the cutover
  (which fails while the switch is `on`). A 503 without Worker headers (for example, a Worker
  over its limits), no answer, or any other answer fails. The workers.dev pass also rejects a
  robots-meta noindex on `/` and a listing page, which is the same on every host. In
  `apps/web/src/lib/environment/`, `public-policy.test.tsx` runs the policy through the Worker
  pipeline and the root layout's analytics decision, and `noindex-sources.test.ts` checks the
  real `next.config.ts` headers and the layout's and pages' robots metadata.
- **Manual check of best.serp.co** (after any gate run that logged `best.serp.co check skipped`;
  [deploy runbook](./deploy-runbook.md#after-a-deploy)). `pnpm tsx scripts/d1-preview-http-gates.ts
  public https://best.serp.co` runs the same best.serp.co checks without skipping anything. Then
  `curl -sI https://best.serp.co/` must show `x-site-environment: production` and an
  `x-worker-version` equal to the version Deploy Production deployed: the id its gate log
  prints (`Worker version <id> answered N probe(s)`), or the active deployment under Workers &
  Pages → `best-serp-co-production` → Deployments in the Cloudflare dashboard.

## URLs and caching

- [URLs](./urls.md): the canonical form of every URL, the redirects, pagination, and what pages
  publish for search engines (sitemaps, structured data).
- [Caching](./caching.md): the catalog epoch and the four cache layers from the edge HTML cache
  inward.

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

`apps/web/drizzle.config.ts` is credential-free: it generates reviewable SQL in `apps/web/drizzle/`;
Wrangler owns migration application and the `d1_migrations` ledger.
