# URLs

How every page and file URL is written, which requests redirect, how listings are paged, and
what the pages publish for search engines. The Worker entry that enforces it is in
[Architecture](./architecture.md); public URLs are part of the SEO contract (`AGENTS.md`).

## One canonical form

Every URL has one canonical form, per the SERP URL trailing-slash and sitemap standards
(serpcompany/serp `docs/engineering/standards/url-trailing-slash.md` and
`docs/engineering/websites/features/xml-sitemaps.md`):

| URL | Canonical form | Non-canonical request |
| --- | --- | --- |
| Homepage | `https://best.serp.co` (written without a slash) | none: `/` is the only path |
| Page | ends with `/`: `/about/`, `/products/autoenhance.ai/` | `/about` -> 308 `/about/` |
| File | never ends with `/`: `/robots.txt`, `/sitemap-pages.xml` | `/robots.txt/` -> 308 `/robots.txt` |
| `/api`, `/api/*`, `/.well-known/*`, `/_next/*` | served exactly as requested | never redirected |

`apps/web/src/lib/seo/canonical-url.ts` defines the rule. A file is a path whose last segment ends
in a known file extension (`FILE_EXTENSIONS` in `apps/web/src/lib/file-extensions.ts`), not any dot:
most listing slugs are domain names (`autoenhance.ai`), and their pages keep the slash. Never add an
extension that is also a top-level domain. The data side holds the invariant: submission intake
(`apps/web/src/db/submissions.ts`), the admin panel's approval (`apps/web/src/lib/admin/decisions.ts`)
and the publication manifest schema (`scripts/d1-publisher.ts`) refuse a listing slug that ends in
one of these extensions (`chart.js`), and a test checks the committed import.

## Redirects

- **Slash variants.** The Worker entry answers a non-canonical request with one 308 before the
  edge cache and before OpenNext (`apps/web/src/lib/routing/trailing-slash.ts`), so slash
  variants are never rendered or cached. The `Location` is relative and keeps the query
  string byte for byte. `skipTrailingSlashRedirect` (in `next.config.ts`) keeps the framework's
  own slash redirect off: it differs between Next.js and OpenNext and has no `/api`
  exception. OpenNext Node middleware is not used (it is experimental on Cloudflare).
- **Moved URLs.** `apps/web/src/lib/routing/redirects.ts` lists them and `next.config.ts`
  applies them (`movedUrlRedirects`): the pre-D1 URL scheme and the old sitemap paths
  redirect permanently this way.
  Next.js matches each source with or without a slash and every destination is canonical, so
  the Worker leaves any request a moved-URL rule matches to OpenNext (it reads the same compiled
  patterns from `.next/routes-manifest.json`), and the request reaches its page in one hop. Add
  static moved URLs there (not as a page that calls `permanentRedirect()`); `redirects.test.ts`
  checks that each destination is canonical and each source is matched in both slash forms.
- **Redirects that need D1** run in their pages (`listing_slug_redirects`: renamed listing slugs,
  and unpublished duplicates sent to the listing they duplicated, #338) or in the Worker (the old
  root-level `/<slug>`, before the slash rule, `apps/web/src/lib/routing/legacy-root.ts`) and
  write a canonical destination (`getRoute`).
- **Fail closed.** The Worker validates the manifest at startup and refuses to start if its shape
  is unexpected (no `redirects` array or route list, a rule without a string `regex`, a pattern
  that does not compile or matches every path), so a framework upgrade cannot silently turn off
  either the Worker's skip of the slash redirect for moved URLs or the root-level `/<slug>`
  redirect.
- **Query strings.** OpenNext re-serializes the query string of config redirects from decoded
  values, so a query that contains an encoded `&`, `=`, `#`, or `+` is not preserved exactly;
  the pre-D1 URLs never carried one.

The Playwright smoke suite (staging) and `scripts/d1-preview-http-gates.ts` (staging and
production) assert the redirects, the `/api` exemption, and the homepage form.

## Written URLs

- **Absolute URLs.** Canonical tags, `og:url`, sitemaps, `robots.txt`, and JSON-LD build absolute
  URLs with `absoluteUrl` (`siteUrl` in `seo-config.ts`), which writes the homepage as the bare
  origin. With `trailingSlash`, the Next.js metadata API appends `/` to every same-origin URL,
  so the homepage (`app/(site)/page.tsx`) leaves `alternates.canonical` and `openGraph.url`
  unset and renders both tags with `HomePageCanonicalTags`. Never render them in
  `HomePageRoute`: `/products/` reuses it, and only its page 1 (canonical `/`) renders them.
  JSON-LD node identifiers keep their fragment form (`https://best.serp.co/#website`); they name
  a graph node, not the page.
- **Origin.** Every absolute URL a page, sitemap, feed or robots.txt writes takes its
  environment's origin, read per request from the Worker's vars, never from the `Host`
  header (`siteOrigin()` in `src/lib/environment/site-origin.ts`, #359): staging writes
  `https://staging.best.serp.co`, and production, local, and the `*.workers.dev` hosts write
  `https://best.serp.co`. Staging sits behind a password, so it can describe itself exactly as
  production will and an SEO audit of it reads like one of production
  ([Environments and hosts](./architecture.md#environments-and-hosts)). Call `siteOrigin()`,
  `siteUrl()` and the other builders in `seo-config.ts` during a request, never at module
  load: page metadata is `generateMetadata()`, not a `metadata` constant. The badge embed
  code and the badge verifier keep best.serp.co's listing URL on every environment: other
  sites copy that code, and staging tests the code production hands out. The site has no
  hreflang (one language).

## Pagination

The directory (`/`, `/products/`) and category pages show 48 listings per page in
directory order (publication order, then a stable locale sort by name, as the pages
always rendered). Later pages use a `?page=N` query parameter on the existing URL:
`/products/?page=2`, `/products/categories/other/?page=3`. The homepage shows page 1 and
links into `/products/?page=N`. `/products/` itself renders the homepage's content, so its
canonical is `/`. Page 1 is the bare URL; pages 2+ are linked with plain `<a href>` anchors,
canonicalize to themselves, carry `noindex, follow` and a "- Page N" title, and a page
past the end is a 404. Category JSON-LD describes the whole category on every page.
`apps/web/src/components/directory/listing-pagination.tsx` owns the parameter, links, and metadata;
`getListingNamePage` in `apps/web/src/db` reads one page (ids in name order are cached
per epoch, then only that page's summaries are read). Routes never load the full catalog
for display; only the sitemaps and the JSON feed read every listing.

## What pages publish for search engines

- **Sitemaps.** On best.serp.co, `/robots.txt` advertises `/sitemap-index.xml` (every other host
  serves a disallow-all robots.txt; staging's gives Ahrefs' Site Audit best.serp.co's rules and
  its own sitemap index; see [Environments and hosts](./architecture.md#environments-and-hosts)).
  The index lists the root-level sitemaps; the older sitemap URLs answer one 308. The route
  registry
  (`apps/web/src/lib/site/site-routes.ts`) sets each static page's indexability and sitemap for
  the sitemaps, robots.txt, page metadata, and footer. A listing's `lastmod` is its later
  `updated_at` or `published_at`; a collection's is its newest listing's.
- **Listing images.** A listing without a usable logo renders the checked-in "no logo" tile
  `apps/web/public/listing-logos/favicon-fallback-512x512.png` (source and render notes in
  `scripts/assets/listing-logo-fallback.svg`). The tile is UI only: listing JSON-LD names
  the listing's own logo as `primaryImageOfPage` and omits the property when there is none,
  rather than give every logo-less listing the same image or the SERP logo
  (`apps/web/src/lib/seo/schema.ts`). `apps/web/e2e/listing-logo-assets.spec.ts` checks
  that the Worker serves the tile and that sample pages reference no missing same-origin file.
- **Listing offers.** D1 holds no product pricing, so listing JSON-LD has no `offers`
  (`generateWebsiteDetailSchema` emits one only for known `pricing`; the submission `plan` is
  the listing fee). `listing-structured-data.spec.ts` checks it.
