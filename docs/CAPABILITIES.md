# Visitor and discoverability capabilities

Status: inventory draft; release evidence contract not yet decided

Responsible area: product and release engineering

Validation: `pnpm docs:check`

This document inventories the behavior that `serp.software` and
`pornvideodownloaders.com` are expected to provide to a Visitor. It is the starting
point for a production confidence contract, not yet a claim that every capability is
proven in production or must block a release.

The governing vocabulary is in [`CONTEXT.md`](../CONTEXT.md). A Visitor is looking
for and evaluating tools without being expected to have technical knowledge.

## Evidence vocabulary

- **Implemented**: the enabled application and shared packages contain the behavior.
- **Locally automated**: a deterministic repository or browser test exercises the
  externally observable behavior against a local D1-backed Worker or a controlled
  boundary.
- **Live verified**: bounded read-only evidence demonstrates the behavior on both
  production Sites.
- **Unknown**: the inventory found no authoritative evidence at that level.

Implemented is not proof that a capability works. The release-blocking evidence
levels and thresholds remain decisions on the active GitHub Wayfinder map.

## Shared Site contract

Both Sites are expected to use the same shared behavior with an explicit Site
identity and separate D1 database. Site-specific names, domains, branding, social
links, catalog contents, category sets, and network links may differ. A capability
must not silently read another Site's data or infer a default Site.

| Capability | Expected Visitor outcome | Current repository evidence | Evidence gap |
| --- | --- | --- | --- |
| Site identity | The page consistently represents the requested Site, domain, branding, and catalog. | Site registry and configuration are explicit; multisite smoke tests assert the selected Site heading, title, representative Listing, category, and exact catalog count. | Current live parity must be verified. |
| Home discovery | The home page loads a D1-derived catalog and exposes clear paths to browse and search. | Both apps use the shared home route with D1 data; multisite smoke tests assert a successful document and exact catalog count. | Complete live content and interaction behavior is not yet recorded. |
| Catalog browsing | A Visitor can scan Listings, see result counts, filter by category, and change ordering without losing the current state unexpectedly. | Public-parity browser tests cover result counts, category navigation, sorting, persistence after reload, and empty search state. | Coverage is concentrated in the pilot configuration and is not yet a release contract for both Sites. |
| Search | A Visitor can search from the home page, header, and search page and reach relevant Listing results. | Shared search UI and bounded D1 search API exist; browser tests cover form submission, autocomplete keyboard navigation, mobile search, result navigation, and empty states. | Relevance expectations, malformed-query behavior, and live results are not yet baselined. |
| Category discovery | Active D1 categories have indexable pages containing eligible Listings; nonexistent or empty categories do not masquerade as valid pages. | Category routes read D1, generate metadata and structured data, and call `notFound()` for missing or empty categories. Multisite smoke covers a representative category. | Every active category and its canonical/indexing state is not yet checked live. |
| Featured discovery | A featured category is available only when eligible featured Listings exist. | The featured route derives its data from D1 and returns not found when the featured count is zero. | No explicit browser assertion or live baseline currently proves this conditional behavior. |
| Listing evaluation | A Visitor can open a canonical Listing detail page and evaluate its summary, content, categories, media, resource links, FAQs, related Listings, and external destination when those fields exist. | Shared detail DTOs and route components exist; browser smoke covers a representative detail route, canonical metadata, structured data, and outbound-link semantics. | Optional-field combinations, media failure states, all structured-data fields, and live representative samples remain incomplete. |
| Listing redirects and absence | A retired Listing slug permanently redirects only to its reviewed canonical replacement; an unknown Listing returns not found. | Detail routes use the D1 redirect lookup before `notFound()`; repository tests cover redirect and catalog contracts. | Representative live redirect chains and final canonical URLs are not yet recorded. |
| Lightweight preferences | A Visitor can favorite Listings and retain supported search/sort preferences locally without an account. | Public-parity tests cover favorite toggling, favorites-only filtering, and sort persistence. | Dedicated `/favorites/` is intentionally disabled on both Sites; the supported scope and storage compatibility need explicit release assertions. |
| Mobile navigation | A Visitor can search, open and close navigation, follow category links, and use the catalog without viewport escape on a phone-sized screen. | Browser tests cover the mobile drawer, search overlay, body scroll locking, navigation, and document/hero containment. | Broader element-level containment and both-Site interaction coverage remain partial. |
| Static information | A Visitor can access enabled about and legal information with correct headings and metadata. | About and legal routes exist; basic browser coverage asserts the about page loads. Sitemap generation includes configured public static pages. | Content presence, metadata, canonicals, and indexing for every enabled static page are not comprehensively asserted. |
| Brands network | A Visitor can reach the enabled Brands surface without falling through to a retired origin. | `showBrands` is enabled for both Sites; the route is shared and visual coverage exists. | Current live origin, canonical, content, and link behavior require verification. |
| Creator entry point | A Creator can reach `/submit/` from Visitor-facing navigation without broken internal-link semantics. | Public-parity tests cover the Submit Yours link; the page loads active categories from D1. | The Creator journey is intentionally secondary to this Visitor-first contract. |
| Disabled surfaces | A Visitor does not encounter partially supported docs, guides, projects, account, login, or dedicated favorites experiences. | Both Site configurations disable auth, docs, favorites, guides, and projects; route feature gates return not found and noindex metadata where applied. | All disabled route families need a consistent route/status/indexing audit. |
| Error and empty states | Missing content, empty results, and recoverable failures are understandable and do not expose internal errors. | Browser tests cover empty search and a basic 404; shared Listing and form error surfaces exist. | D1 outage, malformed response, missing media, and unexpected server failure behavior are not covered as a coherent Visitor contract. |

## Technical discoverability contract

Technical discoverability is grouped with Visitor capabilities because it determines
whether Visitors can find the Sites. Rankings, impressions, and traffic are external
outcomes; this repository can only enforce the technical inputs it controls.

| Capability | Expected behavior | Current repository evidence | Evidence gap |
| --- | --- | --- | --- |
| Canonical URLs | Every indexable page declares the intended HTTPS Site URL; aliases and retired slugs resolve to it without loops. | Shared metadata helpers construct Site-bound canonicals; smoke tests assert a representative Listing canonical. | Route-wide and live canonical coverage is incomplete. |
| Robots directives | Public canonical pages are indexable and followable; private, disabled, error, and duplicate pages are not indexable. | Shared metadata supports index/follow and explicit noindex; `robots.ts` is present for both apps. | A route-by-route expected directive matrix and live verification do not yet exist. |
| Titles and descriptions | Every indexable page has Site-appropriate, nonempty metadata that describes its actual content. | Root, Listing, category, search, static, and legal metadata generators exist. | Uniqueness, length, content quality, and full live coverage are unproven. |
| Social previews | Indexable pages expose correct Open Graph and Twitter metadata using Site-owned images and URLs. | Shared metadata generates Open Graph and Twitter fields; PVD has checked-in branded assets. | Asset validity, SERP fallback quality, dimensions, and live response coverage are unknown. |
| Structured data | Structured data represents the visible Site, breadcrumbs, categories, and Listings without appearing on private or nonexistent content. | Home, category, and Listing routes render JSON-LD; smoke tests assert its presence on a representative Listing; private Submission preview suppresses Listing structured data. | Schema validity and agreement with visible/live content are not comprehensively tested. |
| Sitemap discovery | `/robots.txt` points crawlers to the canonical sitemap index, and the index exposes only enabled sitemap groups. | Shared sitemap code builds Site-bound XML; multisite smoke asserts D1 Listing counts, category membership, and feed responses. | Live index membership, status, content type, canonical host, last-modified policy, and excluded routes need a complete baseline. |
| Sitemap eligibility | Sitemaps contain only approved, active, published D1 Listings and active categories, with no disabled or duplicate route surfaces. | D1 query predicates and sitemap builders encode eligibility; `/products/` is explicitly excluded because it redirects to home. | Exact live URL sets and indexability agreement are not yet continuously proven. |
| Feed discovery | The public feed contains eligible D1 Listings, correct Site identity, stable URLs, and valid response metadata. | Multisite smoke asserts the feed status, content type, Site home URL, and exact Listing count. | Live validity, item fields, ordering, and canonical agreement remain to be checked. |
| Redirect integrity | HTTP and route redirects preserve the intended canonical path without chains, loops, or retired origins. | Application routes include permanent Listing redirects and the deployment architecture owns apex/`www` routing. | A current live redirect inventory is missing. |
| Analytics presence | The configured Site analytics container loads without breaking Visitor behavior or leaking cross-Site identity. | Each Site has a distinct checked-in GTM ID and shared integration. | Consent expectations, live load, duplicate tags, and event correctness are unknown. |

## Quality properties

| Property | Expected behavior | Existing evidence | Evidence gap |
| --- | --- | --- | --- |
| Availability | Critical public routes return the intended successful, redirect, or not-found status from the correct Worker. | Worker builds and local D1 browser smoke pass. | No agreed live route set, service objective, or automated post-deploy probe exists. |
| Accessibility | Core journeys are keyboard operable, semantically named, readable, and usable with reduced technical knowledge. | Tests use roles and accessible names for major controls; responsive interaction coverage exists. | No comprehensive automated accessibility scan or manual assistive-technology baseline exists. |
| Performance | Critical pages remain fast enough for Visitors and crawlers without excessive D1 work or asset weight. | D1 query benchmarks and warm-query production evidence exist. | No Visitor-centric Core Web Vitals or route performance budgets have been selected. |
| Responsive layout | Critical content and controls remain within the viewport at supported phone and desktop sizes. | Multisite smoke checks document and hero containment; public-parity covers mobile overlays. | Coverage does not yet include every critical page and long-content state. |
| Site isolation | A Site never displays another Site's catalog, metadata, analytics identity, or branding. | Separate D1 bindings/configuration plus tenant predicates and multisite tests enforce major boundaries. | A live cross-Site sentinel check and complete metadata/asset isolation proof are missing. |
| Safe degradation | Cache, optional content, or third-party failures do not corrupt public data or expose private state. | Catalog cache contracts fall back to live D1; public/private query boundaries are tested. | Visitor-visible behavior under dependency failures is not systematically exercised. |

## Intentional Site differences

- Each Site has its own name, domain, copy, analytics ID, social links, branding,
  categories, Listing set, and network-brand group.
- PVD has checked-in logo, favicon, and Open Graph assets; SERP currently uses shared
  or fallback branding behavior.
- Both Sites have one isolated active replacement Preview Worker/D1 identity. Their
  temporary Issue #72 source Preview databases were deleted with retained exports and
  receipts; that evidence is not permission to create substitute Preview identities.
- Both Sites currently enable Brands and newsletter surfaces and disable auth, docs,
  dedicated favorites, guides, projects, creator-projects, and external-resources
  surfaces.

## Existing automated evidence seams

- `apps/e2e/tests/multisite-smoke.spec.ts`: selected Site identity, exact D1 catalog,
  representative Listing/category/search behavior, canonical metadata, structured
  data, sitemap/feed contracts, and mobile containment.
- `apps/e2e/tests/public-parity.spec.ts`: desktop and mobile search, autocomplete,
  navigation, local favorites, sorting, empty states, and link semantics.
- `apps/e2e/tests/minimal.spec.ts` and `home.spec.ts`: basic route and document smoke.
- `scripts/architecture-guard.test.ts`: D1-only and forbidden architecture paths.
- `scripts/sitemap-files.test.ts`, `audit-sitemaps.test.ts`, and
  `submit-gsc-sitemaps.test.ts`: sitemap generation, audit, and Search Console
  operational contracts.
- `packages/data-ops/` tests and benchmark: public eligibility, projections,
  navigation, related Listings, caching, and bounded D1 query behavior.
- `pnpm harness:check`: documentation, architecture, D1 contracts, types, lint,
  repository tests, Worker configuration, and both Worker builds without deployment.

## Decisions still required

1. Which rows and properties are required to block a production release?
2. What constitutes sufficient local, preview, and live evidence for each required
   capability?
3. Which accessibility and performance thresholds are release-blocking?
4. How should the shared SERP Preview target evolve to isolate concurrent pull requests?
5. Which live checks run before deployment, immediately afterward, and continuously?
6. What rollback or traffic response follows a failed post-deployment invariant?
