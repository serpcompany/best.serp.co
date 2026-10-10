# Claims

A signed-in user claims an existing, ownerless listing (serpcompany/best.serp.co#59, #67): they
prove an address on the listing's domain with an emailed code, then either the badge (free) or a
payment (#68), and become its owner. The flow lives in `apps/web/src/lib/claims/` (no SQL) and
`apps/web/src/db/claims.ts`; the API is `POST /api/claims` and
`POST /api/claims/<id>/<action>`.

## Switching it on

Claims run only while `features.claims` (`apps/web/src/lib/features.ts`) is on. **It is on** since
#130 (the owner's launch decision, 2026-10-07): every listing page without a current owner shows
"Work at …? Claim this listing" in the panel beside its header (#70 screen 9a, #273), which opens
the claim dialog (`apps/web/src/components/claims/claim-listing.tsx`, #70 screen 8; a drawer on a
phone). A visitor signs in first and comes back to `#claim`. Held listings and listings whose
slug and landing disagree still show the link, and the dialog answers "This URL can’t be claimed." with
"Message us" (the contact path, `/contact/` while #73 is off). The dialog's badge card and
success alert say the badge is checked weekly because the [badge program](./badge-program.md)
is on too.

Paid claims also need `features.orders` (#68), which is on since #133: the dialog offers
"Install the badge (free)" (chosen) and "Skip the badge: $49 one-off", and "Continue to payment"
opens `/claims/<id>/checkout/` ([Billing](./billing.md)). The `ownership-removed` email offers to
claim again ("claim it again with the badge or a $49 one-off payment", "Claim <name> again") only
while both flags are on, so it does now. With orders off, the dialog offers only the badge,
`POST /api/claims` refuses `method: 'paid'` (`422 invalid_method`), and the checkout answers
404.

Turning the flag off again makes every claim endpoint answer 404, removes the claim link, and
leaves claims in progress where they are. A local Worker can still run claims with the flag off
(`LOCAL_PREVIEW_VARS=LOCAL_CLAIMS=on`; ignored unless `SITE_ENVIRONMENT` and `D1_RUNTIME_ENV` are
both `local`). No suite needs it while the flag is on: `apps/web/e2e/claims.spec.ts` and
`claims-dialog.spec.ts` run on the site's flags.

## The flow

Order (#70): method → work email → code → badge check or payment → done, so nobody pays before
proving the address.

1. **The product's domain** (`apps/web/src/lib/claims/product.ts`). Most imported listings store a
   `serp.ly` affiliate link as their website, so the claim never uses that domain. A website on
   the product's own domain is the product's site; a `serp.ly` (or other shortener) link is
   followed server-side through the shared safe fetcher, HTTP redirects and then up to five
   `<meta http-equiv="refresh">` hops, reading pages up to 2 MB, and the landing page's domain is
   the product's. When the slug is a domain (the owner's search decision: the product slug, never
   the `serp.ly` host), it must be that same domain. SERP's own domains and link shorteners never
   count (`409 no_product_domain`). A slug and landing that disagree, or a link that can't be
   followed (a 403, a timeout, a chain that keeps refreshing), need the owner's review: the claim
   answers `409 review_required` with the contact path, because a lapsed or reassigned domain
   could be registered by anyone. So does a listing on #100's owner-review lists (off-domain,
   unreachable), held in `listing_claim_holds` (see "Holds" below). The product page found is
   stored with the claim (`product_url`), and the badge is checked there.
2. **Start** (`POST /api/claims`, `{ listing: <slug>, method, email }`). The listing must be live,
   have no current owner (else `409 already_owned` with `contactPath`: `/contact/`, or a claim
   conversation once #73 ships; with `self: true` when the caller is the owner, so the dialog
   says they manage it), and not be under a prohibited-URL block on the product's
   domain. The address must be well formed, not free webmail (`WEBMAIL_DOMAINS`), never on
   SERP's domains (`@serp.ly` proves nothing), and its domain's registrable domain (Public Suffix
   List, private section included) must be the product's: `www.` and subdomains normalize, and a
   site on a shared host with no registrable domain can't be claimed by email. A single-use
   6-digit code goes to that address (`claim-code`, code in the subject, through the email ledger
   keyed per code), valid 10 minutes. Asking again sends a new code (another address or method is
   allowed), at most one a minute. Sends count per account (10 an hour), client address (20),
   recipient address (3), domain (10), and listing (10).
3. **Confirm** (`confirm`, `{ code }`). The code in time confirms the address and is spent. Each
   wrong code uses one of 5 attempts, counted across resends; the fifth burns the code and locks
   the claim for 15 minutes, after which a new code can be sent and the count starts over. An
   expired or burned code is `410 code_expired`.
4. **Badge** (`verify-badge`, free method). The submit flow's verifier checks the product page
   for the badge linking to the listing (one check per 30 seconds, the badge step's outbound
   budget); every request, redirects included, must stay on the claim domain, else the result is
   `invalid_redirect`. Completion compares with the domain stored with the claim, without
   fetching, unless an admin changed the listing's website since (then a domain that no longer
   matches, or can't be resolved, is `409 changed`). A pass, within 24 hours of the confirmation, makes the
   claimer the owner (`verified_via = badge_claim`), cancels other open claims, and advances the
   catalog version (the public "Verified owner" badge). The weekly
   [badge program](./badge-program.md) then checks the claimer's product page, and removes the
   owner (the listing stays up, curated) if the badge is confirmed missing; a later replay of the
   claim then answers `409 not_owner`.
5. **Payment** (paid method, #68). "Continue to payment" opens `/claims/<id>/checkout/`
   ([Billing](./billing.md)); `completePaidClaim` makes the claimer the owner (`paid_claim`)
   once billing records the payment, after the same product-domain re-check; the badge is
   then optional and never checked. An owned listing answers `already_owned` with the contact
   path.

After a claim the owner sees the listing in `/account` (#65), where edits go to review, and an
admin sees and can transfer the owner (#64).

## Holds

A hold sends every instant claim of a listing to the contact path until the owner decides it.
Holds are placed and cleared only through reviewed row-level manifests published by the protected
Publish D1 Catalog workflows, never by hand SQL:

- `listing-claim-hold-add` (`reason` `off_domain` | `unreachable` | `admin`, a `note`, and the
  `expected` website): the listing must still have that slug and website. An active hold is left
  as it is; a cleared one is placed again.
- `listing-claim-hold-clear` (a `note`): clears the listing's active hold, recording the actor.

`d1/publications/2026-10-06-listing-claim-holds.yaml` holds #100's owner-review sets (266
off-domain, 391 unreachable), generated by `pnpm catalog:claim-holds` from
`d1/hygiene/2026-10-06-listing-domains.yaml`; a test keeps it equal to the report. The migration
only creates the table, so an environment gets the holds by publishing the manifest, like the
other catalog manifests. Re-run `pnpm catalog:domains -- --env production` periodically and
publish a new hold manifest from its report ([Catalog hygiene](./catalog-hygiene.md)).

`d1/publications/2026-10-10-mismatch-claim-holds-clear.yaml` clears five of those holds (#340):
renamed listings whose new website, set by `2026-10-10-mismatch-renames`, replaces the link that
caused the hold. Publish it after the renames ([Catalog hygiene](./catalog-hygiene.md#mismatched-listings-340)).

## Data

`listing_claims` (`0008_listing_claims`): the claimer, the method (`badge` | `paid`), the status
(`code_sent` → `email_verified` → `completed`, or `cancelled`), the domain address and its
registrable domain (the product's), `product_url`, the current code as an HMAC (`code_hash`,
cleared once used or burned), its expiry, the codes sent, the wrong `attempts` (0 to 5), and
`locked_until`, and the listing's website it was resolved from (`listing_website`). A user has at
most one open claim per listing (`listing_claims_open_idx`). `listing_claim_holds` (listing,
reason `off_domain` | `unreachable` | `admin`, source, `cleared_at`/`cleared_by`) holds instant
claims for the owner's review.
Completing a claim writes the `listing_owners` row (`badge_claim` or `paid_claim`) and cancels the
listing's other open claims in one batch.

## Security

Every endpoint needs a session and a trusted `Origin` (CSRF), and reads and writes only the
session user's claim (someone else's is a 404). Codes are stored as HMAC-SHA256 under a key
derived from the auth secret (`best.serp.co/claim-code/v1`), bound to the claim, and never
logged. Every transition is a compare-and-swap, so a repeated or concurrent request can't spend a
code twice, exceed the attempts, or grant a second owner.
