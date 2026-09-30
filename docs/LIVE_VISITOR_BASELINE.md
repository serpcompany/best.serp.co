# Live Visitor and discoverability baseline

Status: point-in-time production research for GitHub issue
[#43](https://github.com/serpcompany/directory-platform-d1/issues/43)

Observed: 2026-08-13 00:00-00:14 UTC

Source revision: `47488b73ae25c68c3a0a184c38711ad36ee3c23e` (`origin/main` at the
start of the final evidence pass)

Scope: bounded, read-only checks of representative public routes on
`serp.software` and `pornvideodownloaders.com`, correlated with the repository
sources that own their expected behavior. No authenticated route, form submission,
Cloudflare mutation, deployment, or production D1 operation was performed.

This is a point-in-time baseline, not an availability guarantee, a complete
accessibility audit, or a Core Web Vitals field study. It informs the release evidence
contract still being decided in GitHub issue
[#44](https://github.com/serpcompany/directory-platform-d1/issues/44).

## Executive result

The sampled Visitor journeys are live on both Sites: home, representative Listing,
category, search, about, Brands, Submit, not-found, JSON feed, and split sitemap
surfaces returned the expected content. Site-specific canonical URLs, robots
directives, titles, and structured data were present on the representative indexable
pages. Mobile checks at 390 by 844 CSS pixels found no horizontal overflow on the
sampled home, search, category, and Listing routes.

The baseline also found four controllable gaps:

1. **Release-blocking candidate — HTTP canonicalization:** both
   `http://serp.software/` and `http://pornvideodownloaders.com/` returned `200` and
   the complete Site HTML instead of redirecting to HTTPS. The sampled HTTPS
   responses also had no `Strict-Transport-Security` header.
2. **Release-blocking candidate — disabled route indexing:** both Sites intentionally
   disable `showFavorites`, and `/favorites/` correctly returns HTTP `404`, but the
   rendered page declares `robots=index, follow`, a `/favorites/` canonical, and a
   "Saved Favorites" title while displaying the not-found body. Other sampled
   disabled routes (`/docs/`) returned coherent noindex metadata.
3. **Release-process gap:** the production workflows validate and deploy but do not
   run the runbook's live functional/SEO checks automatically before considering the
   job complete. Post-release checks are currently instructions for the Maintainer.
4. **Quality and efficiency candidates:** both homepage descriptions contain a double
   period, all sampled HTML responses declare `Cache-Control: private, no-cache,
   no-store, max-age=0, must-revalidate`, and the homepage documents are roughly
   672-674 KB decoded HTML. These are observations to investigate, not proven search
   or Visitor regressions.

## Live capability matrix

| Surface | `serp.software` | `pornvideodownloaders.com` | Result |
| --- | --- | --- | --- |
| Home | `200`; one H1; Site canonical; `index, follow`; `WebSite` JSON-LD | Same Site-bound behavior | Verified for the sample |
| Listing detail | `/products/123movies-downloader/`; `200`; canonical; `index, follow`; one H1; valid JSON-LD graph | `/products/321tube-downloader/`; same contract | Verified for representative Listings |
| Category | `/categories/video-downloaders/`; `200`; 338 Listing links; Site canonical; `CollectionPage` and breadcrumb JSON-LD | Same route; 285 Listing links | Verified for one active category per Site |
| Search | `/search/?q=123movies`; result links to the expected Listing; `noindex, nofollow` | `/search/?q=321tube`; expected result and directives | Verified for one exact query per Site |
| Static information | `/about/`, `/brands/`, and `/submit/` returned `200` | Same | Status and representative metadata verified; content quality not audited |
| Not found | Unknown route returned `404` and `noindex` | Same | Verified; the raw first response sometimes exposed zero server-rendered H1 tags, while the hydrated browser displayed the H1 |
| Sitemaps | Index plus 8 page, 339 Listing, and 4 taxonomy URLs | Index plus 8 page, 286 Listing, and 4 taxonomy URLs | Counts, canonical hosts, status, and XML content type verified |
| Feed | JSON Feed v1; 339 items; correct Site URLs | JSON Feed v1; 286 items; correct Site URLs | Shape, identity, count, and first item verified |
| Legacy routes | `www` to apex `301`; `/news` `307`; `/website/...`, `/websites/...`, and root Listing aliases resolve toward `/products/...` | Same representative behavior | Application aliases verified; HTTP-to-HTTPS missing |
| Mobile layout | No horizontal overflow at 390 px on home, category, search, and Listing samples | Same | Representative containment verified |
| Accessibility signals | Home has header/nav/main/footer landmarks, one H1, no missing image `alt`, and no sampled unnamed controls | Same | Positive smoke signals only; not a conformance audit |
| Observable performance | Browser sample: home FCP 808 ms, Listing FCP 472 ms; curl TTFB samples varied 151-1306 ms (home) and 236-821 ms (Listing) | Home FCP 600 ms, Listing FCP 404 ms; curl TTFB samples varied 135-166 ms (home) and 110-1022 ms (Listing) | Healthy point samples with outliers; insufficient for budgets or SLOs |

## Technical discoverability findings

### Metadata, canonicals, and structured data

Browser-rendered evidence showed:

- the two home pages use their own HTTPS apex canonical, `index, follow`, Open Graph
  URL, Twitter summary-card metadata, and valid `WebSite` JSON-LD;
- the sampled Listing pages use the expected `/products/<slug>/` canonical,
  `index, follow`, one visible H1, and parseable `WebPage`, `BreadcrumbList`,
  `SoftwareApplication`, `TechArticle`, and `FAQPage` data;
- the sampled category pages use Site-bound canonicals, `index, follow`, and
  parseable `CollectionPage` and breadcrumb data;
- search canonicalizes away the query string to `/search/` and correctly declares
  `noindex, nofollow`;
- unknown routes return `404` with `noindex` metadata.

The repository behavior matches these positive observations: shared metadata builds
Site-bound canonical, Open Graph, Twitter, and robots values in
`packages/web-core/src/seo-config.ts`, and both Listing routes delegate their
metadata to the shared detail implementation.

Two metadata defects were observed:

- Homepage descriptions render the configured tagline followed by another period,
  for example `directory.. Browse`. `packages/web-core/src/home-page.tsx` appends a
  period even though both checked-in taglines already end with one.
- A disabled Favorites request is rendered using `favoritesPageMetadata` exported at
  module scope before `requireRouteFeature('showFavorites')` calls `notFound()`.
  Consequently, the `404` body inherits indexable Favorites metadata. The shared
  disabled-route metadata helper exists but this route does not select it during
  metadata generation.

### Robots, sitemap, and feed

Both `/robots.txt` responses returned `200` and ended with the application-owned
rules:

```text
User-Agent: *
Allow: /
Disallow: /404
Disallow: /500
Disallow: /submit
Disallow: /search

Sitemap: https://<site>/sitemap-index.xml
```

Cloudflare prepended managed crawler/content-signal rules, including blocks for
Google-Extended, GPTBot, and Meta's external agent. This baseline does not judge that
Cloudflare policy; it records that the application crawler rules and canonical
sitemap pointer remained present.

Each sitemap index returned three direct URL-set children: pages, Listings, and
taxonomies. The page sitemap contained home, about, Brands, and five legal routes;
Submit and Search were absent. Listing and feed counts agreed for each Site (339 for
SERP, 286 for PVD). The `/sitemap.xml` compatibility route returned `307` to the
canonical `/sitemap-index.xml` on both Sites.

The code supports the observed contract: `packages/web-core/src/sitemaps.ts` builds
the three index entries and crawler exclusions, while each Site's `rss.xml` handler
maps the D1-derived Listing collection into JSON Feed v1 items.

### Redirects and transport

The following representative application redirects behaved coherently:

| Request pattern | Observed response |
| --- | --- |
| `https://www.<site>/` | `301` to the HTTPS apex |
| `https://<site>/news` | `307` to `/` |
| `https://<site>/website/<slug>` | `308` toward `/products/<slug>` |
| `https://<site>/websites/<slug>` | `308` toward `/products/<slug>` |
| `https://<site>/<slug>` | `308` to canonical `/products/<slug>/` for the sampled Listing |

Transport canonicalization failed on both Sites: a direct HTTP request returned
`200 OK`, not a redirect, and the HTTPS header sample contained no HSTS policy. This
creates two fetchable schemes even though page metadata canonically points to HTTPS.
The redirect tests in the repository cover application paths; no release gate found
in this investigation currently asserts HTTP-to-HTTPS behavior.

## Visitor journey and responsive findings

At a 390 by 844 viewport, the browser could:

- identify the Site through its H1;
- discover accessible, named menu, search, Submit, Listing, category, theme, and
  social controls;
- return the representative Listing from the Search page;
- show 338 SERP or 285 PVD Listing links on the representative category;
- open the representative Listing and expose named outbound action/resource links;
- contain the document within a 390-pixel layout on every sampled critical route.

The homepage DOM on each Site exposed one `header`, one `main`, one `footer`, four
`nav` elements, one H1, 215 images with no missing or empty `alt` attribute, and zero
unnamed links/form controls under the bounded heuristic used here. Category and
Listing samples also had zero unnamed controls under that heuristic.

These checks are accessibility signals, not WCAG proof. No axe/pa11y dependency,
automated accessibility release step, screen-reader session, contrast audit, zoom
test, or full keyboard journey was found or run. The page's early heading sequence
also includes headings from hidden mobile/navigation shells before the main H1;
whether that harms assistive navigation requires a dedicated audit.

## Observable performance and caching

Three unthrottled curl samples per home and representative Listing produced:

| Route | TTFB range | Total range | Decoded HTML observed by curl |
| --- | ---: | ---: | ---: |
| SERP home | 151-1306 ms | 263-1409 ms | about 674 KB |
| SERP Listing | 236-821 ms | 291-885 ms | about 208-212 KB |
| PVD home | 135-166 ms | 219-300 ms | about 672 KB |
| PVD Listing | 110-1022 ms | 232-1056 ms | about 196-202 KB |

One fresh headless mobile navigation per representative route reported:

| Route | Browser TTFB | FCP | Load event | Resources |
| --- | ---: | ---: | ---: | ---: |
| SERP home | 214 ms | 808 ms | 793 ms | 101 |
| SERP Listing | 376 ms | 472 ms | 660 ms | 43 |
| PVD home | 259 ms | 600 ms | 556 ms | 92 |
| PVD Listing | 239 ms | 404 ms | 417 ms | 41 |

These are local-to-observer, unthrottled point samples. They cannot establish Core
Web Vitals or a release budget. No reliable LCP entry was available from this bounded
headless pass. Field data and a controlled Lighthouse/WebPageTest-style laboratory
profile remain gaps.

Every sampled HTML response declared private/no-store caching, despite the
architecture distinguishing public-page HTTP caching from authenticated responses.
This may be intentional OpenNext behavior or an optimization gap; the baseline does
not infer a regression without a decided cache contract. The large home HTML payload
is consistent with rendering hundreds of Listing cards and is an obvious performance
investigation target.

## Release-gate coverage

The local multisite browser smoke already proves a useful subset:

- selected Site identity and exact catalog count;
- representative Listing, category, and search behavior;
- Listing canonical and presence of structured data;
- exact Listing sitemap/feed counts and representative taxonomy membership;
- homepage mobile containment.

However, the production workflows do not run these tests against the deployed
origin. SERP's workflow runs config, D1, type, and Worker build checks before deploy;
PVD's production workflow runs the full harness plus target validation and build.
Both then end after the deploy command. `docs/DEPLOY_RUNBOOK.md` tells the Maintainer
to verify home, category, Listing, search, feed, sitemaps, redirects, metadata, and
error behavior afterward, but the workflow neither runs nor records those checks.

The next evidence-contract decision should therefore separate:

1. pre-deploy deterministic gates against the exact artifact and Site identity;
2. preview gates where an isolated preview exists (currently PVD only);
3. post-deploy, fail-loud live probes against both canonical domains;
4. continuous monitoring for transport, route, metadata, sitemap/feed, performance,
   accessibility, and Site-isolation drift.

## Reproduction commands

The following commands are representative of the exact read-only methods used. Run
them from the repository root; live values will naturally change after a release.

```bash
# Route status, headers, and timing
curl -sS -o /dev/null -D - \
  -w 'status=%{http_code} ttfb=%{time_starttransfer}s total=%{time_total}s bytes=%{size_download}\n' \
  https://serp.software/

# Prove or disprove transport canonicalization without following redirects
curl -sS -o /dev/null --max-redirs 0 \
  -w 'status=%{http_code} location=%{redirect_url}\n' \
  http://pornvideodownloaders.com/

# Sitemap membership and counts
curl -sS https://serp.software/listings-sitemap.xml | rg -o '<loc>' | wc -l
curl -sS https://pornvideodownloaders.com/taxonomies-sitemap.xml \
  | rg -o '<loc>[^<]+' | sed 's#<loc>##'

# Feed identity and count
curl -sS https://pornvideodownloaders.com/rss.xml \
  | jq '{version,title,home_page_url,feed_url,item_count:(.items|length)}'

# Browser-rendered metadata and mobile containment
agent-browser --session live-baseline open \
  https://serp.software/products/123movies-downloader/
agent-browser --session live-baseline set viewport 390 844
agent-browser --session live-baseline wait --load networkidle
agent-browser --session live-baseline eval --stdin <<'JS'
({
  title: document.title,
  canonical: document.querySelector('link[rel="canonical"]')?.href,
  robots: document.querySelector('meta[name="robots"]')?.content,
  h1: [...document.querySelectorAll('h1')].map(element => element.textContent?.trim()),
  jsonLd: document.querySelectorAll('script[type="application/ld+json"]').length,
  horizontalOverflow:
    document.documentElement.scrollWidth > document.documentElement.clientWidth
})
JS
agent-browser --session live-baseline close
```

## Facts, inferences, and remaining gaps

### Verified facts

- The URLs, statuses, counts, metadata, structured-data types, DOM signals, timings,
  headers, and redirect responses reported above were observed during the bounded UTC
  window.
- Both Sites currently serve their public catalogs from distinct public identities;
  representative result/count differences were visible and consistent with the live
  sitemap/feed counts.
- The workflow and test coverage statements are based on the checked-in sources at
  the recorded revision.

### Inferences requiring a decision or deeper test

- HTTP availability and missing HSTS increase duplicate-scheme and transport risk;
  whether Cloudflare has an intended external canonicalization layer that is simply
  disabled cannot be determined from repository sources alone.
- Private/no-store HTML and large home documents are performance opportunities, but
  their actual effect on search or Visitors needs controlled lab and field evidence.
- Point timing samples show variability, not an availability or latency regression.
- Positive semantic/label heuristics reduce obvious accessibility risk but do not
  establish conformance.

### Not proven by this baseline

- every Listing, category, redirect, canonical, external link, image, and structured
  data field;
- ranking, impressions, traffic, crawl/index coverage, or Search Console state;
- uptime, multi-region latency, Core Web Vitals distributions, or cache hit ratios;
- complete keyboard, screen-reader, contrast, reduced-motion, zoom, and touch-target
  behavior;
- failure behavior during D1, cache, asset, analytics, or third-party outages;
- authenticated, private Submission, Maintainer, or production recovery journeys;
- post-release rollback behavior after a failed live invariant.

These gaps should become explicit evidence levels or follow-on implementation
tickets; they should not be silently interpreted as passing.
