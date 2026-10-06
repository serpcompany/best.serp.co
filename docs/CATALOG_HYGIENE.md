# Catalog hygiene: listing domains

Some listings' product domains now serve gambling or betting pages, are parked, or are for sale
(serpcompany/best.serp.co#100). The owner decided on 2026-10-06:

- **Unpublish** the clear cases: gambling, betting, or spam pages, and parked or for-sale
  domains. Their pages answer 410 Gone and leave the sitemap, search, and RSS, through the
  admin panel's unpublished state ([Admin panel](./ADMIN_PANEL.md#unpublished-listings-answer-410)).
  The rows stay; Republish in `/admin` brings a listing back.
- **Owner list only:** listings that end on another company's site (an acquisition such as
  `gretel.ai` → NVIDIA, or a rebrand) or are unreachable. They may be legitimate moves or
  outages, so nothing unpublishes them automatically.

## The check

```bash
pnpm catalog:domains                # fetch and classify; writes d1/hygiene/<date>-listing-domains.yaml
pnpm catalog:domains -- --reuse     # reuse .runtime/listing-domains/, fetch only what is missing
pnpm catalog:domains -- --only a.ai,b.io   # print the classification of a few listings
pnpm catalog:domains -- manifest    # write d1/publications/<date>-hijacked-domains.yaml
```

It is read-only. The listings come from the reviewed import (`d1/artifacts`), the catalog both
environments were bootstrapped from. Most websites are `serp.ly` links that redirect in the
browser, so the check follows HTTP redirects, `<meta http-equiv="refresh">`, and script-only
redirect pages to the page a visitor lands on:

- **Fetching** reuses the submission flow's `safeFetch` (`apps/web/lib/submissions/`): every hop
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

The manifest is applied like any publication: on staging first (the staging publish path is
#97), then on production after promotion. It keeps the publisher's version check: its
`basePublicationVersion` and `beforeChecksum` are the reviewed import's (version 1), so it
applies only while an environment's `publication_state` is still there. **Publish it before
#98's media manifests**, which are row-level and apply at any version. If an environment has
moved on anyway (another publication or an admin decision), regenerate it with
`--base-version` and `--base-checksum`; its per-row guards (`expected.website`, categories, live,
no submission in review) hold on either environment, so `listing-unpublish` could also join a
row-level mode like #97's without other changes.

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
- **Order:** it is based on the state #100's manifest leaves (publication version 2). Publish
  #100's, then this one, then #98's media manifests (row-level, any version). Staging first
  (#97's staging path), then production after promotion. If an environment has moved on,
  regenerate with `--base-version` and `--base-checksum` (and a new `--manifest-id`); the row
  guards hold on either environment.
- **Until it is published**, the FAQs section leaves out an FAQ whose exact `### <question>`
  heading line the description still holds (`faqsToShow`), so imported FAQs never show twice.
  It never matches text in prose, and is a no-op once the manifest is published; remove it
  then.

