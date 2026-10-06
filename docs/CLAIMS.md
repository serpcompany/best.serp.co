# Claims

A signed-in user claims an existing, ownerless listing (serpcompany/best.serp.co#59, #67): they
prove an address on the listing's domain with an emailed code, then either the badge (free) or a
payment (#68), and become its owner. The flow lives in `apps/web/lib/claims/` (no SQL) and
`packages/data-ops/src/claims.ts`; the API is `POST /api/claims` and
`POST /api/claims/<id>/<action>`.

## Switching it on

Claims run only while `features.claims` (`apps/web/lib/features.ts`) is on; while it is off every
claim endpoint answers 404 and nothing on the site links to a claim. **It ships off**: the claim
dialog and the listing page's Claim link (#70 screens 8 and 9) are not built yet, because their
approved copy wasn't available to build from. The API, data, emails and tests are complete, so
the dialog only has to call them. A local Worker runs claims with the flag off
(`LOCAL_PREVIEW_VARS=LOCAL_CLAIMS=on`; ignored unless `SITE_ENVIRONMENT` and `D1_RUNTIME_ENV` are
both `local`), which `apps/e2e/tests/claims.spec.ts` uses. Paid claims also need `features.orders`
(#68): while it is off only the badge method exists, and nothing completes a paid claim.

## The flow

Order (#70): method → work email → code → badge check or payment → done, so nobody pays before
proving the address.

1. **The product's domain** (`apps/web/lib/claims/product.ts`). Most imported listings store a
   `serp.ly` affiliate link as their website, so the claim never uses the website's domain as
   such. As for search (the owner's decision: match on the product slug, never the `serp.ly`
   host), the product's domain is the slug's when the slug is a host with a registrable domain
   (`jasper.ai`), else the website's when it is the product's own, else where the website's link
   lands: it is followed server-side through the shared safe fetcher, HTTP redirects and then up
   to two `<meta http-equiv="refresh">` hops (as `serp.ly` answers). SERP's own domains and link
   shorteners never count. Without a product domain the listing can't be claimed
   (`409 no_product_domain`). The product page found this way is stored with the claim
   (`product_url`), and the badge is checked there.
2. **Start** (`POST /api/claims`, `{ listing: <slug>, method, email }`). The listing must be live,
   have no current owner (else `409 already_owned` with `contactPath`: `/contact/`, or a claim
   conversation once #73 ships), and not be under a prohibited-URL block on the product's
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
   `invalid_redirect`. The listing's product domain is checked again first (an admin edit since
   the code makes it `409 changed`). A pass, within 24 hours of the confirmation, makes the
   claimer the owner (`verified_via = badge_claim`), cancels other open claims, and advances the
   catalog version (the public "Verified owner" badge). The weekly
   [badge program](./BADGE_PROGRAM.md) then checks the claimer's product page, and removes the
   owner (the listing stays up, curated) if the badge is confirmed missing; a later replay of the
   claim then answers `409 not_owner`.
5. **Payment** (paid method, #68). `completePaidClaim` makes the claimer the owner (`paid_claim`)
   once #68's webhook records the payment, after the same product-domain re-check; the badge is
   then optional and never checked. An owned listing answers `already_owned` with the contact
   path.

After a claim the owner sees the listing in `/account` (#65), where edits go to review, and an
admin sees and can transfer the owner (#64).

## Data

`listing_claims` (`0008_listing_claims`): the claimer, the method (`badge` | `paid`), the status
(`code_sent` → `email_verified` → `completed`, or `cancelled`), the domain address and its
registrable domain (the product's), `product_url`, the current code as an HMAC (`code_hash`,
cleared once used or burned), its expiry, the codes sent, the wrong `attempts` (0 to 5), and
`locked_until`. A user has at most one open claim per listing (`listing_claims_open_idx`).
Completing a claim writes the `listing_owners` row (`badge_claim` or `paid_claim`) and cancels the
listing's other open claims in one batch.

## Security

Every endpoint needs a session and a trusted `Origin` (CSRF), and reads and writes only the
session user's claim (someone else's is a 404). Codes are stored as HMAC-SHA256 under a key
derived from the auth secret (`best.serp.co/claim-code/v1`), bound to the claim, and never
logged. Every transition is a compare-and-swap, so a repeated or concurrent request can't spend a
code twice, exceed the attempts, or grant a second owner.
