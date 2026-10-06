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

1. **Start** (`POST /api/claims`, `{ listing: <slug>, method, email }`). The listing must be live,
   have no current owner (else `409 already_owned` with `contactPath`: `/contact/`, or a claim
   conversation once #73 ships), and not be under a prohibited-URL block. The address must be
   well formed, not free webmail (`WEBMAIL_DOMAINS`), and its domain's registrable domain (Public
   Suffix List, private section included) must be the website's: `www.` and subdomains
   normalize, `jo@mail.brieflow.ai` claims `https://www.brieflow.ai/`, and a site on a shared
   host with no registrable domain can't be claimed by email. A single-use 6-digit code goes to
   that address (`claim-code`, code in the subject, through the email ledger keyed per code),
   valid 10 minutes. Asking again sends a new code (another address or method is allowed), at
   most one a minute; sends also count per account (10 an hour) and client address (20).
2. **Confirm** (`confirm`, `{ code }`). The code in time confirms the address and is spent. Each
   wrong code uses one of 5 attempts; the fifth burns the code and locks the claim for 15
   minutes, after which a new code can be sent. An expired or burned code is `410 code_expired`.
3. **Badge** (`verify-badge`, free method). The submit flow's verifier checks the website for the
   badge linking to the listing (one check per 30 seconds, the badge step's outbound budget). A
   pass, within 24 hours of the confirmation, makes the claimer the owner (`verified_via =
   badge_claim`), cancels other open claims, and advances the catalog version (the public
   "Verified owner" badge). The weekly [badge program](./BADGE_PROGRAM.md) then checks the listing,
   and removes the owner (the listing stays up, curated) if the badge is confirmed missing.
4. **Payment** (paid method, #68). `completePaidClaim` makes the claimer the owner (`paid_claim`)
   once #68's webhook records the payment; the badge is then optional and never checked.

After a claim the owner sees the listing in `/account` (#65), where edits go to review, and an
admin sees and can transfer the owner (#64).

## Security

Every endpoint needs a session and a trusted `Origin` (CSRF), and reads and writes only the
session user's claim (someone else's is a 404). Codes are stored as HMAC-SHA256 under a key
derived from the auth secret (`best.serp.co/claim-code/v1`), bound to the claim, and never
logged. Every transition is a compare-and-swap, so a repeated or concurrent request can't spend a
code twice, exceed the attempts, or grant a second owner.
