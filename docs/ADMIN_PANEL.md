# Admin panel

`/admin` (serpcompany/best.serp.co#64) is where admins review submissions and owner revisions,
manage listings, and manage the admin allowlist. The screens follow the mockups approved in #70
(screens 10 to 14 and the admin shell). The shell is shadcn sidebar-07 (`collapsible="icon"`
with a rail), composed in `apps/web/src/components/admin/admin-shell.tsx` from the dashboard pieces
the account area shares (`@/components/dashboard/*`, with serplists' sidebar rows, account menu
and top bar since #261); pages set their breadcrumb with `AdminCrumbs`.

| Screen | Route | Reads |
|---|---|---|
| Review queue | `/admin/submissions/` (`?view=changes`, `?view=all`) | `selectReviewQueuePlan` |
| Submission review | `/admin/submissions/<id>/` | `selectSubmissionReviewPlans` |
| Revision review | `/admin/revisions/<id>/` | `selectRevisionReviewPlans` |
| Listings | `/admin/listings/` (`?q=`, `status`, `source`, `link`, `page`, `size`) | `selectAdminListingsPlans` |
| Listing | `/admin/listings/<slug>/` | `selectAdminListingPlans` |
| Admins | `/admin/admins/` | `selectAdminAllowlistPlan` |
| Orders (#68) | `/admin/orders/` | `selectAdminOrdersPlan` (`src/db/billing.ts`) |

The reads are statement plans in `apps/web/src/db/admin-queries.ts`; `apps/web/src/lib/admin/`
holds no SQL (the architecture guard checks it). Orders (screen 13, [Billing](./BILLING.md)) are
shown while orders are on (`features.orders`, on since #133); otherwise the entry is hidden and
`/admin/orders/` is a 404. The Inbox and the conversation panels on screens 11 and 12 are #73's.

## Requests

Admin writes are route handlers, never Server Actions (#64 decision; the architecture guard
forbids `'use server'`): an action id is reachable from any path, so no path gate would see it.

| Endpoint (`POST` unless noted) | Body | Decision |
|---|---|---|
| `/api/admin/submissions/<id>/approve` | `expectedContentVersion`, optional `edits`, `linkRel` | `approveSubmission` |
| `/api/admin/submissions/<id>/request-changes` | `note` | `requestSubmissionChanges` |
| `/api/admin/submissions/<id>/reject` | `reason`, `category` (`prohibited` \| `other`) | `rejectSubmission` |
| `/api/admin/{submissions,listings}/<id>/allow-resubmission` | optional `urlKey` (checked only) | `allowResubmission` |
| `/api/admin/revisions/<id>/{approve,request-changes,reject}` | as above, no category | `approveRevision`, … |
| `/api/admin/listings/<id>/details` | `details`, `expectedChecksum` | `updateListingDetails` |
| `/api/admin/listings/<id>/{unpublish,republish}` | optional `note` | `unpublishListing`, `republishListing` |
| `/api/admin/listings/<id>/link-rel` | `linkRel` | `setListingLinkRel` |
| `/api/admin/listings/<id>/{transfer-owner,remove-owner}` | `email`, `expectedOwnerUserId` | `transferListingOwner`, `removeListingOwner` |
| `/api/admin/admins` (`POST` adds, `DELETE` removes) | `email` | `addAdmin`, `removeAdmin` |
| `/api/admin/orders/<id>/refund` | none | `refundOrder` ([Billing](./BILLING.md)) |

Every request passes, in order: the Worker's Cloudflare Access and session-cookie gate
([Accounts](./ACCOUNTS.md#admin-gate)); `authorizeAdminRequest()`, which re-checks the session
and the allowlist and, for any write, requires an `Origin` among the Worker's trusted origins
(the CSRF check: every `*.serp.co` site is same-site, so `SameSite=Lax` alone is not enough);
a JSON body (`application/json`, at most 64 KB) parsed by its schema (`lib/admin/schemas.ts`);
then the decision (`lib/admin/decisions.ts`). Answers are JSON with `cache-control: private,
no-store`: `200 {ok: true, replayed}`, or `{ok: false, error, message}` with 404, 409 (the state
changed), 422 (invalid input), or 503.

## Decisions

Each decision reads the current state, answers a replay of a decision that already happened as
`{ok: true, replayed: true}` without writing (it only retries the decision's email or refund,
below), and otherwise sends the reviewed statement plans as one D1 batch:

- **Compare and swap.** Approvals send the `content_version` the admin saw (a reviewer's inline
  edit increments it in the same batch, then the approval swaps on the new value), listing edits
  the listing `checksum`, ownership changes the owner the admin saw. A stale page gets 409 and
  reloads. A race between two identical requests ends with one write and one replay. A catalog
  decision whose batch lost only the race for the global publication version (another listing
  published in between, while this item is as it was read) runs once more on fresh state, so
  two admins on different listings don't see a false 409.
- **Publication.** Anything that changes public output (approve, reject a live listing,
  unpublish, republish, link, details, ownership) goes through `prepareCatalogPublication` and
  records a `publication_runs` row (`actor` = the admin's email, `workflow = 'app/admin'`),
  advancing the catalog epoch, so cached pages turn over within about a minute.
- **Audit.** Submission decisions are `listing_submission_events` (actor, note or reason and
  category, the fields a reviewer edited), revision decisions `listing_revision_events`, and
  listing changes `listing_events` (`edited`, `unpublished` with the note, `republished`,
  `link_rel_changed`, `owner_granted`, `owner_revoked`, `owner_transferred`).
- **Rules from the plans.** A listing whose submission is in review cannot be edited or
  unpublished (edit or reject the submission instead); a rejected listing stays down and
  read-only; a transfer needs a verified account; the last admin cannot be removed (the plan
  refuses it inside the batch, so two admins cannot remove each other at once).
- **URLs follow the submission intake.** A website or logo URL that an edit changes must pass
  `validatePublicHttpUrl` (public HTTP(S) only). One the edit leaves alone is neither checked
  nor rewritten, so an imported listing keeps its legacy website, site-relative logo
  (`/listing-logos/…`), or missing logo through any other edit. Clearing a listing's logo
  removes it, and its page shows the fallback tile.
- **A new website must not collide** (`listingWebsiteConflicts`, the intake's rule). It is
  refused when another listing's slug is its host (`urlKey`), when another listing's stored
  website is one of its spellings (`websiteSpellings`: http or https, with or without `www.`,
  with or without a trailing slash, and with any query or fragment ignored on either side,
  `listingWebsiteMatch`), when its host is a submission in flight, or when an active
  prohibited-URL block covers its host. The decision answers 409 with which one, and the edit's
  batch refuses the same collisions. The slug never changes. Other listings' websites are
  compared as URLs, not hosts: most imported slugs aren't their host, so a listing at
  `https://new.example/pricing` doesn't stop a move to `https://new.example/`. A stored website
  key is #94.
- **"Allow resubmission" acts on the record in the path.** It lifts the block on that
  submission's block key, or on the key of the listing's latest submission. An unknown id is
  404. A body `urlKey`, the key the admin confirmed, is only compared with it (409 when they
  differ), so a request can't lift a block on another URL.

Emails go through `enqueueEmail` ([Email](./EMAIL.md)), built from the stored state whenever
the decision holds. A replay enqueues the same email under the same event key: the ledger sends
it at most once, and resends one whose first send failed (a provider outage), so retrying the
decision is the recovery path.

| Decision | Template | Event key |
|---|---|---|
| Approve (free) | `listing-approved` | `submission-approved:<id>` |
| Request changes | `changes-requested` | `submission-changes-requested:<id>:<n>` (the nth request) |
| Reject, `other` | `submission-rejected` | `submission-rejected:<id>` |
| Reject, `prohibited` | `submission-rejected-prohibited` | `submission-rejected:<id>` |

Approving a paid submission sends nothing yet: `listing-approved` is the free listing's email
(it asks to keep the badge), and #70 has no paid approval email; a paid listing that went live
on payment was told so then (`listing-live-paid`). Revision decisions send nothing until their
templates exist.

### Refunds

Rejecting a paid submission as `other` promises a refund. The billing module provides the refund
hook (`AdminRefunds`, `refundRejectedSubmission` in `lib/billing/service.ts`) while orders are on
and billing is configured; otherwise that decision answers 409 `refund_unavailable` and changes
nothing. The contract:

- The rejection batch is the refund-pending marker: `status = 'rejected'`,
  `rejection_category = 'other'`, `paid_at` set and `refunded_at` null
  (`selectRefundPendingSubmissionsPlan`). The refund is recorded with
  `buildRefundSubmissionPlans` (`after_rejection`), which sets `refunded_at` and clears it.
- The hook runs after the batch, again on every replay of the rejection, and from the billing
  sweep of pending rows, so it is idempotent (the provider idempotency key `refund:<order>`). It records the refund and sends `submission-rejected-refunded`;
  the rejection email is not sent for these.
- When the hook throws, the rejection stands, the decision answers
  `{ok: true, refundPending: true}`, and the refund stays pending for the next replay or sweep.

## Unpublished listings answer 410

Unpublishing keeps the row (`status = 'approved'`, `is_active = 0`); the public queries drop it
from pages, search, the sitemap, RSS, and counts. Its URL answers **410 Gone** with screen 9's
page (the listing is gone, a link to its category, "Relist it"). Next.js cannot answer 410, so
the Worker entry does it (`lib/routing/gone-listing.ts`): when a `/products/<slug>/` render is a
404, it asks D1 whether the slug is unpublished (`isUnpublishedListingSlug`, one index seek) and,
if so, renders the page again with `x-best-serp-co-render-gone: 1`, which makes the page render
the gone page, and answers it with 410. The edge cache stores the 410 under the epoch.

An unpublished listing filed under a retired category (`categories.is_active = 0`, primary or
secondary) keeps its plain 404 (#260): `isUnpublishedListingSlug` and `getUnpublishedListing` leave
it out, so there is no gone page, category link, or "Relist it". That is how the adult listings
left ([Catalog hygiene](./CATALOG_HYGIENE.md#adult-products-260)). Such a listing stays down: the
listing screen shows why instead of Republish, `republishListing` answers 409
`listing_category_retired` with the same reason, and the plan and D1
(`0011_retired_categories`) refuse it too.

## The production-write exception

The repository rule is that production data changes only through protected GitHub Actions. The
admin panel is the one exception (#59, #64): on production, a decision made in `/admin` writes
production D1 from the Worker, without a workflow, a reviewer approval, or a bookmark. Its
guards instead:

- the Cloudflare Access application on `/admin*` and `/api/admin*`, plus an admin session whose
  verified email is on the D1 allowlist, re-checked on every request;
- the trusted-`Origin` check on every write, JSON-only bodies, and no Server Actions;
- only the reviewed statement plans in `apps/web/src/db`, each a compare-and-swap with
  `changes()` assertions, so a write applies whole or not at all;
- an audit row per decision with the admin's email, and a `publication_runs` row per catalog
  change.

Recovery is D1 Time Travel, run by the owner ([D1 recovery](./D1_RECOVERY.md)). Nothing else in
the app writes production data, and agents never use the production admin panel.

## Tests

`apps/web/src/db/{admin-plans,admin-queries,listing-plans}.test.ts` and
`apps/web/src/lib/admin/decisions.test.ts` (node:sqlite), `scripts/d1-workerd-plans.test.ts` (every
plan builder and read on Wrangler-local D1), and `apps/web/e2e/admin-panel.spec.ts`
(Playwright: the gate, approve, request changes, reject, allow resubmission, unpublish with 410
and republish, the allowlist, and a replay of each decision). The suite runs on its own local
Worker and empty D1 (`PLAYWRIGHT_PORT` + 3, started by `playwright.config.ts` from the same
build), because it publishes listings and the smoke suite counts the fixture seed's listings
exactly.
