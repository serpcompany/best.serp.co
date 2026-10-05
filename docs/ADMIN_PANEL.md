# Admin panel

`/admin` (serpcompany/best.serp.co#64) is where admins review submissions and owner revisions,
manage listings, and manage the admin allowlist. The screens follow the mockups approved in #70
(screens 10 to 14 and the admin shell). The shell is shadcn sidebar-07 (`collapsible="icon"`
with a rail), composed in `apps/web/components/admin/admin-shell.tsx` from the dashboard pieces
the account area shares (`@serpdirectory/web-core/dashboard/*`); pages set their breadcrumb with
`AdminCrumbs`.

| Screen | Route | Reads |
|---|---|---|
| Review queue | `/admin/submissions/` (`?view=changes`, `?view=all`) | `selectReviewQueuePlan` |
| Submission review | `/admin/submissions/<id>/` | `selectSubmissionReviewPlans` |
| Revision review | `/admin/revisions/<id>/` | `selectRevisionReviewPlans` |
| Listings | `/admin/listings/` (`?q=`, `status`, `source`, `link`, `page`, `size`) | `selectAdminListingsPlans` |
| Listing | `/admin/listings/<slug>/` | `selectAdminListingPlans` |
| Admins | `/admin/admins/` | `selectAdminAllowlistPlan` |

The reads are statement plans in `packages/data-ops/src/admin-queries.ts`; `apps/web/lib/admin/`
holds no SQL (the architecture guard checks it). Orders (screen 13) need #68's ledger: the entry
is hidden behind `ADMIN_ORDERS_ENABLED` (`apps/web/lib/admin/features.ts`) and `/admin/orders/`
is a 404 until #68. The Inbox and the conversation panels on screens 11 and 12 are #73's.

## Requests

Admin writes are route handlers, never Server Actions (#64 decision; the architecture guard
forbids `'use server'`): an action id is reachable from any path, so no path gate would see it.

| Endpoint (`POST` unless noted) | Body | Decision |
|---|---|---|
| `/api/admin/submissions/<id>/approve` | `expectedContentVersion`, optional `edits`, `linkRel` | `approveSubmission` |
| `/api/admin/submissions/<id>/request-changes` | `note` | `requestSubmissionChanges` |
| `/api/admin/submissions/<id>/reject` | `reason`, `category` (`prohibited` \| `other`) | `rejectSubmission` |
| `/api/admin/submissions/<id>/allow-resubmission` | `urlKey` | `allowResubmission` |
| `/api/admin/revisions/<id>/{approve,request-changes,reject}` | as above, no category | `approveRevision`, … |
| `/api/admin/listings/<id>/details` | `details`, `expectedChecksum` | `updateListingDetails` |
| `/api/admin/listings/<id>/{unpublish,republish}` | optional `note` | `unpublishListing`, `republishListing` |
| `/api/admin/listings/<id>/link-rel` | `linkRel` | `setListingLinkRel` |
| `/api/admin/listings/<id>/{transfer-owner,remove-owner}` | `email`, `expectedOwnerUserId` | `transferListingOwner`, `removeListingOwner` |
| `/api/admin/admins` (`POST` adds, `DELETE` removes) | `email` | `addAdmin`, `removeAdmin` |

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
`{ok: true, replayed: true}` without writing or emailing, and otherwise sends the reviewed
statement plans as one D1 batch:

- **Compare and swap.** Approvals send the `content_version` the admin saw (a reviewer's inline
  edit increments it in the same batch, then the approval swaps on the new value), listing edits
  the listing `checksum`, ownership changes the owner the admin saw. A stale page gets 409 and
  reloads. A race between two identical requests ends with one write and one replay.
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

Emails go through `enqueueEmail` ([Email](./EMAIL.md)), once per event key:

| Decision | Template | Event key |
|---|---|---|
| Approve (free) | `listing-approved` | `submission-approved:<id>` |
| Request changes | `changes-requested` | `submission-changes-requested:<id>:<n>` (the nth request) |
| Reject, `other` | `submission-rejected` | `submission-rejected:<id>` |
| Reject, `prohibited` | `submission-rejected-prohibited` | `submission-rejected:<id>` |

Approving a paid submission sends nothing yet: `listing-approved` is the free listing's email
(it asks to keep the badge), and #70 has no paid approval email; a paid listing that went live
on payment was told so then (`listing-live-paid`). Revision decisions send nothing until their templates exist. Rejecting a paid
submission as `other` promises a refund: until #68 provides the refund hook (`AdminRefunds`),
that decision answers 409 `refund_unavailable` and changes nothing.

## Unpublished listings answer 410

Unpublishing keeps the row (`status = 'approved'`, `is_active = 0`); the public queries drop it
from pages, search, the sitemap, RSS, and counts. Its URL answers **410 Gone** with screen 9's
page (the listing is gone, a link to its category, "Relist it"). Next.js cannot answer 410, so
the Worker entry does it (`lib/routing/gone-listing.ts`): when a `/products/<slug>/` render is a
404, it asks D1 whether the slug is unpublished (`isUnpublishedListingSlug`, one index seek) and,
if so, renders the page again with `x-best-serp-co-render-gone: 1`, which makes the page render
the gone page, and answers it with 410. The edge cache stores the 410 under the epoch.

## The production-write exception

The repository rule is that production data changes only through protected GitHub Actions. The
admin panel is the one exception (#59, #64): on production, a decision made in `/admin` writes
production D1 from the Worker, without a workflow, a reviewer approval, or a backup. Its guards
instead:

- the Cloudflare Access application on `/admin*` and `/api/admin*`, plus an admin session whose
  verified email is on the D1 allowlist, re-checked on every request;
- the trusted-`Origin` check on every write, JSON-only bodies, and no Server Actions;
- only the reviewed statement plans in `packages/data-ops`, each a compare-and-swap with
  `changes()` assertions, so a write applies whole or not at all;
- an audit row per decision with the admin's email, and a `publication_runs` row per catalog
  change.

Recovery is D1 Time Travel, run by the owner ([D1 recovery](./D1_RECOVERY.md)). Nothing else in
the app writes production data, and agents never use the production admin panel.

## Tests

`packages/data-ops/src/{admin-plans,admin-queries,listing-plans}.test.ts` and
`apps/web/lib/admin/decisions.test.ts` (node:sqlite), `scripts/d1-workerd-plans.test.ts` (every
plan builder and read on Wrangler-local D1), and `apps/e2e/tests/admin-panel.spec.ts`
(Playwright: the gate, approve, request changes, reject, allow resubmission, unpublish with 410
and republish, the allowlist, and a replay of each decision). The suite runs on its own local
Worker and empty D1 (`PLAYWRIGHT_PORT` + 3, started by `playwright.config.ts` from the same
build), because it publishes listings and the smoke suite counts the imported catalog exactly.
