# Catalog hygiene

What best.serp.co lists, and how listings that don't belong leave: [adult products](#adult-products-260)
are never listed, and [the listing domain check](#the-check) finds hijacked, parked, and dead domains.

## Listing domains

Some listings' product domains now serve gambling or betting pages, are parked, or are for sale
(serpcompany/best.serp.co#100). The owner decided on 2026-10-06:

- **Unpublish** the clear cases: gambling, betting, or spam pages, and parked or for-sale
  domains. Their pages answer 410 Gone and leave the sitemap, search, and RSS, through the
  admin panel's unpublished state ([Admin panel](./ADMIN_PANEL.md#unpublished-listings-answer-410)).
  The rows stay; Republish in `/admin` brings a listing back.
- **Owner list only:** listings that end on another company's site (an acquisition such as
  `gretel.ai` → NVIDIA, or a rebrand) or are unreachable. They may be legitimate moves or
  outages, so nothing unpublishes them automatically.
- **Dead domains** (owner decision of 2026-10-07, #104): an owner-list listing whose domain does
  not exist (DNS NXDOMAIN for its link, and for its own domain when that differs) in two checks
  a day or more apart is unpublished too. An HTTP error, a timeout, or a TLS failure is not.
- **Gone or trash** (owner decision of 2026-10-07, #104): the rest of the owner list was reviewed
  listing by listing into `d1/hygiene/2026-10-07-owner-list-decisions.yaml`. *Gone*: still
  unreachable a day later, with the product's homepage failing too (the check's fetcher and curl).
  *Trash*: the link and the listing's own domain land on something other than the listed product.
  Rebrands, acquisitions that still offer the product, and broken links whose own domain still
  serves the product stay live.

## The check

```bash
pnpm catalog:domains                # fetch and classify; writes d1/hygiene/<date>-listing-domains.yaml
pnpm catalog:domains -- --reuse     # reuse .runtime/listing-domains/, fetch only what is missing
pnpm catalog:domains -- --only a.ai,b.io   # print the classification of a few listings
pnpm catalog:domains -- manifest    # write d1/publications/<date>-hijacked-domains.yaml
pnpm catalog:domains -- --only <the earlier report's NXDOMAIN slugs> \
  > d1/hygiene/<date>-dead-domains.recheck.yaml   # the second check, a day or more later
pnpm catalog:domains -- dead-manifest --since <earlier date>
                                    # write d1/publications/<date>-dead-domains.yaml
pnpm catalog:domains -- decisions-manifest   # d1/hygiene/<date>-owner-list-decisions.yaml →
                                    # d1/publications/<date>-owner-list-cleanup.yaml
pnpm catalog:domains -- adult-manifest       # #260, see Adult products above
pnpm catalog:claim-holds -- d1/hygiene/<date>-listing-domains.yaml <date>-listing-claim-holds
                                    # hold instant claims of the owner list (#67)
```

Re-run the check periodically (a lapsed product domain can be re-registered by anyone), then
generate a claim-hold manifest from the new report and publish it like any catalog manifest:
holds already placed stay as they are. The owner clears a hold with a
`listing-claim-hold-clear` operation ([Claims](./CLAIMS.md)).

It is read-only. The listings come from the reviewed import (`d1/artifacts`), the catalog both
environments were bootstrapped from. Most websites are `serp.ly` links that redirect in the
browser, so the check follows HTTP redirects, `<meta http-equiv="refresh">`, and script-only
redirect pages to the page a visitor lands on:

- **Fetching** reuses the submission flow's `safeFetch` (`apps/web/src/lib/submissions/`): every hop
  must be a public http(s) URL, each request times out after 12 seconds, and a page is read up to
  2 MB. On a maintainer machine there is no Cloudflare egress, so its fetcher
  (`scripts/listing-domain-fetch.ts`) also allows ports 80 and 443 only and checks every address
  a host resolves to when the socket connects (an IP-literal URL is checked in the fetcher
  itself, because Node skips the DNS hook for it). Requests are GETs without credentials, with a
  browser user agent carrying `SERPCatalogCheck/1.0`, because hijacked domains often show bots a
  different page. Timeouts, dropped connections, 429, and 5xx are retried twice. A redirect chain
  is followed for up to 36 hops; one that runs out is `unreachable`, never judged by where it
  stopped.
- **The listing's own domain** is fetched directly as well when the slug is a domain and the
  link never reached it (it points at another domain, or failed on the way). It can only add the
  gambling or parking class, and only when the link reaches no page: if the link lands on a
  live, unflagged site (an acquisition), the listing goes to the owner list instead.
- **Classifying** (`scripts/listing-domain-classifier.ts`) compares the final page's registrable
  domain (eTLD+1) with the listing's: the slug when it is a domain, otherwise the first hop past
  `serp.ly` and affiliate networks. `www`, `http`/`https`, SERP's own sites, and store pages
  (Chrome Web Store, app stores, GitHub) count as the listing's own.

| Class | Signal | Outcome |
|---|---|---|
| `gambling-spam` | A gambling, betting, or spam phrase (including operator brands and Xoilac soccer-stream piracy) in the title, description, or heading backed by a second one, four anywhere, or one in the host name backed by the page; off the listing's domain also one plus three Indonesian gambling-SEO words, two in the markup (betting ads), or 30 "slot" mentions (slot ads) | Unpublish |
| `parking` | On the listing's own domain, or reached through it: a parking or marketplace provider host (Sedo, Dan, Afternic, GoDaddy, Bodis, ParkingCrew, Spaceship, Snagged, Atom, ExpiredDomains, ...), a "for sale" or "parked" phrase in the title, description, or heading, or a provider's markup on a near-empty page (GoDaddy's `/lander`) | Unpublish |
| `off-domain` | The page is on another registrable domain, including a link to a different domain that is parked (the product may be live on its own) | Owner list |
| `unreachable` | No page after retries: DNS, TLS, refused, or a 4xx or 5xx that is not bot protection | Owner list |
| `ok` | Anything else, including a 403 or 429 from Cloudflare-style bot protection | Counted only |

The unpublish classes must be precise. Phrases count, not single words, so "casinos and
hotels" or "the odds of success" never do; a "for sale" in a page's body does not count. A
listing that is itself about gambling or domain names never gets either class from page words:
it goes to the owner list. `scripts/listing-domain-check.test.ts` pins these cases.

## The report and the manifest

The report lists each flagged listing with its final URL, status, reason, and the marker that
matched. `manifest` turns its `unpublish` list into one `listing-unpublish` operation per
listing, with its reason (the activity log shows it, as for an admin unpublish) and the
website it was checked against (`expected.website`). The batch refuses the whole manifest if any
listing's website or categories changed, it is no longer live, or its own submission is in
review, and a test keeps the committed manifest identical to what the report generates.

The manifest is row-level (`concurrency: rows`, as #97 introduced): it names no base version,
and each operation's own guards (`expected.website`, categories, live, no submission in review)
decide whether it applies, so one file fits staging and production whatever else each published
(admin decisions, #98's and #105's manifests) and publishes in any order relative to them. A row-level
`listing-unpublish` must carry `expected.website`. It is applied like any publication: on
staging first (the staging publish path is #97), then on production after promotion. If an
environment refuses it (a listing changed there), nothing is written: drop or fix that listing
in a new report and manifest under a new date.

## Adult products (#260)

**best.serp.co lists no adult products** (owner decisions of 2026-10-09): nothing built for adult
content, including every downloader for an adult video or cam site. Fan-site downloaders
(OnlyFans, JustForFans, and Fansly) stay, and so do general-purpose downloaders (YouTube, Vimeo,
and the like). A submission for an adult product is rejected in review
([Submission flow](./SUBMISSION_FLOW.md#review-in-the-admin-panel-64)). An adult listing found
after these manifests can't leave the same way: a retired category can't be added to a listing,
so for now it can only be unpublished, and its URL answers 410 with the gone page, not 404. How
such a listing should leave is the owner's open question.

- **The decisions.** `d1/hygiene/2026-10-09-adult-decisions.yaml` lists the 272 adult listings of
  the reviewed catalog: 259 filed under the Adult category, and 13 adult-site downloaders filed
  under other categories (12 that #98 gave Adult as a secondary category, and
  `ashemaletube-downloader`, which no keyword caught). They were found by the category, by
  `ADULT_TERMS` (`scripts/migration/legacy-media.ts`) and a broader word list over every listing's
  text, FAQs, resource links, and media URLs, and by reading every downloader listing outside
  Adult. `kept` records the four fan-site downloaders and the keyword matches that stay, and why.
- **The manifests.** `2026-10-09-adult-category.yaml` gives `ashemaletube-downloader` the Adult
  category (as #98 did), then `2026-10-09-adult-removal.yaml` takes Adult off the kept fan-site
  downloaders (`listing-categories-remove`, never a primary category), unpublishes the 272
  (`listing-unpublish`, as #148's cleanup), and retires Adult and GIF Downloaders, whose only
  listing was RedGifs (`category-unpublish`: `categories.is_active = 0`, refused while a live
  listing remains in it). Fansite Downloaders keeps its listings and stays. Publish them in that
  order: the removal refuses whole until the category manifest is published. Both are row-level
  and disjoint from every other unpublish manifest. Check each environment first (below).
- **404, not 410.** An unpublished listing filed under a retired category answers a plain 404,
  never the gone page with its category link and "Relist it" (`listingInRetiredCategory` in
  `apps/web/src/db/plan-support.ts`), so every listing the removal unpublishes and the retired
  categories' pages answer 404, and adult search traffic isn't sent elsewhere. A retired category
  leaves the navigation, the category index, the sitemaps, search, RSS, and the submit and edit
  forms, which read active D1 categories.
- **It stays down.** The rows stay, but nothing makes such a listing live again: `/admin` refuses
  Republish and says why ([Admin panel](./ADMIN_PANEL.md#unpublished-listings-answer-410)), a paid
  relist is never offered (and a payment that raced is refunded), and D1 refuses it on any path
  (`0011_retired_categories`: a published listing is never filed under a retired category).
- **Brands.** `/brands/` shows the shared brand data's `noAdult` group until #193 replaces it.

```bash
pnpm catalog:domains -- adult-manifest   # d1/hygiene/<date>-adult-decisions.yaml →
                                         # d1/publications/<date>-adult-category.yaml and
                                         # d1/publications/<date>-adult-removal.yaml
```

**Before publishing the removal** on an environment, after its category manifest, check its
targets read-only. A listing approved into Adult since the import, or one of the 272 already
unpublished, makes the removal refuse whole (nothing is written; regenerate it):

```bash
pnpm exec wrangler d1 execute best-serp-co-staging --env staging --remote --json \
  --config apps/web/wrangler.jsonc --command \
  "SELECT c.slug, SUM(l.status='approved' AND l.is_active=1) AS live,
     SUM(NOT (l.status='approved' AND l.is_active=1)) AS not_live
   FROM categories c JOIN listing_categories lc ON lc.category_id=c.id
     JOIN listings l ON l.id=lc.listing_id
   WHERE c.slug IN ('adult','gif-downloaders') GROUP BY c.slug"
```

Expect `adult` 276 live (the 272 and the 4 kept) and 0 not live (every one of the 272 is filed
under Adult once the category manifest is published, so none is already unpublished), and
`gif-downloaders` 1 live and 0 not live. On production, use `best-serp-co-production --env
production`.

The generator reads the reviewed catalog as the committed manifests leave it
(`reviewedCatalogDatabase`: the import plus every committed manifest that sorts before the ones
being generated and adds or removes categories, unpublishes, or retires one), so each operation
expects the categories staging and production have. It refuses a live listing of a retired category that the decisions neither unpublish nor
keep, and `scripts/listing-domain-check.test.ts` keeps the committed manifests identical to the
decisions, applies them to the reviewed catalog, and checks that exactly the decided categories
retire, that kept listings stay live off them, that no other listing named for an adult platform
is live, and that every removed URL answers 404.

## Listing FAQs (#105)

The one-time import wrote each listing's FAQs twice: as `listing_faqs` rows and as a closing
`## FAQ` block in the long description (`scripts/migration/generate-initial-artifact.ts` appended
it after the body and a blank line): 335 listings, 2,254 FAQs, each under a `### <question>`
heading. The listing page now shows `listing_faqs` in its FAQs section, so the owner decided on
2026-10-06 to move them: `d1/publications/2026-10-06-listing-faqs.yaml` removes each block.

```bash
pnpm catalog:faqs                  # count what would change
pnpm catalog:faqs -- manifest      # write the manifest from the reviewed import
```

- Each operation is `listing-content-remove-suffix`: the description must still be exactly its
  imported length (in SQLite characters) and end with exactly the block, or the whole batch is
  refused. It keeps every other character, sets a new checksum (so a revision or admin edit read
  before it is stale), and logs an `edited` event. The generator refuses a listing whose block
  isn't the last section or doesn't say exactly its FAQs, and a test applies the manifest to the
  reviewed import and checks every description byte by byte.
- **Order:** the manifest is row-level (`concurrency: rows`, as #97 introduced): it names no
  base version, so it publishes in any order relative to #100's and #98's (also row-level) and fits
  staging and production whatever else each published. Staging first (#97's staging path), then
  production after promotion.
- **A description that changed** on an environment (an approved revision, an admin edit) makes
  the publisher refuse the whole batch. Leave such listings out of a new manifest with
  `pnpm catalog:faqs -- manifest --skip <slug> --manifest-id 2026-10-07-listing-faqs-staging`
  (`--skip` is repeatable or comma-separated; the id names the file, `d1/publications/<id>.yaml`,
  so the reviewed manifest stays) and fix them by hand, as their FAQs already show in the section.
- **Until it is published**, the FAQs section leaves out an FAQ whose exact `### <question>`
  heading line the description still holds after its last `## FAQ` line (`faqsToShow`), so
  imported FAQs never show twice.
  It never matches text in prose, and is a no-op once the manifest is published; remove it
  then.

