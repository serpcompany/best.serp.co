# Submission flow

## Statuses and transitions

Native submissions (serpcompany/best.serp.co#59) move through these statuses in
`listing_submissions.status`. Every transition is a compare-and-swap statement plan in
`packages/data-ops/src/submission-plans.ts` (`submissionTransitions`), tested for every source
status in `submission-plans.test.ts`; see [Data model](./DATA_MODEL.md#statement-plans).

| Status | Meaning | Live | Review queue |
| --- | --- | --- | --- |
| `draft` | Saved from the form; no plan chosen, or paid chosen and checkout not completed | no | no |
| `pending_badge` | Free chosen; the badge is not verified yet | no | no |
| `verified` | Waiting for review: free with a verified badge, or paid with a failed guardrail check | no | yes |
| `paid_pending_review` | Paid and the guardrail checks passed: live, and waiting for review | yes | yes |
| `changes_requested` | A reviewer asked for edits (`reviewer_note`) | if it was | no |
| `approved` | Accepted; its listing was published | yes | no |
| `rejected` | Refused with `rejection_reason` and `rejection_category` | no | no |
| `withdrawn` | Withdrawn by its owner, expired, or cleared by an admin (`withdrawal_reason`) | no | no |

| Transition | From | To |
| --- | --- | --- |
| choose free | `draft` | `pending_badge` (`plan = 'free'`) |
| choose paid | `draft` | `draft` (`plan = 'paid'`, awaiting checkout) |
| badge verified | `pending_badge` | `verified` |
| payment, checks passed | `draft` with `plan = 'paid'`, `pending_badge`, or free `verified` | `paid_pending_review`; the listing is published |
| payment, a check failed | the same | `verified` with `plan = 'paid'` |
| payment after withdrawal | `withdrawn`, unpaid | unchanged; payment and full refund recorded together |
| upgrade | `approved`, free, live | unchanged; `plan = 'paid'` |
| approve | `verified` | `approved`; the listing is created and published |
| approve | `paid_pending_review` | `approved`; its staged content replaces the live listing's |
| request changes | `verified`, `paid_pending_review` | `changes_requested` |
| resubmit | `changes_requested` | `paid_pending_review` when it has a listing (still live), otherwise `verified` |
| withdraw (owner) | `draft`, `pending_badge`, `verified`, `changes_requested`, unpaid and not live | `withdrawn` (`owner`) |
| clear draft (admin) | `draft` | `withdrawn` (`admin`) |
| expire (system) | `draft` saved 30 days ago or more | `withdrawn` (`expired`, event `expired`) |
| reject | `pending_badge`, `verified`, `paid_pending_review`, `changes_requested` | `rejected` |
| edit (owner) | `draft`, `pending_badge`, `changes_requested` | unchanged (`edited`, `content_version` + 1) |
| edit (reviewer) | any non-final status | unchanged (`edited`, `content_version` + 1) |

- Drafts never enter the review queue, are never badge-checked, and trigger no badge or review
  email. Like every non-final status, a draft holds its URL key against duplicates (the
  `listing_submissions_active_slug_idx` partial unique index).
- Drafts expire (#59 owner decisions, `draft-plans.ts`). The clock is `draft_saved_at`, the
  first save; edits never reset it. Reminders are due 12 hours, 48 hours, 7, 14, and 21 days
  after it, in two variants: `choose_plan` (no plan chosen; CTA "Choose a plan") and
  `complete_checkout` (paid chosen, not paid; CTA "Complete checkout"). They stop on payment,
  choosing free (`pending_badge`), withdrawal, or expiry; a run that missed some sends only the
  latest one due. At 30 days every draft is withdrawn as `expired`, including a paid draft that
  never completed checkout, which frees its URL, and gets the "draft expired" email; an expired
  draft cannot choose a plan. The hourly scheduled job ([below](#draft-reminders-and-expiry))
  reads `selectDraftRemindersDuePlan` (which
  returns the `variant`) and `selectExpiredDraftsPlan`, claims each reminder with
  `buildMarkDraftReminderSentPlans` for that variant (a compare-and-swap, so a reminder is claimed
  once and matches the current state), and then sends through the email ledger with
  `draftReminderEmailKey` or `draftExpiredEmailKey` as the idempotency key.
- An approved submission creates its listing with `source = 'submission'` and a `nofollow`
  outbound link, and makes the signed-in submitter its owner (`verified_via = 'submission'`).
- Approvals compare and swap on the `content_version` the reviewer saw. The live approval also
  requires the listing to be unchanged since it was published (`published_checksum`). While a
  listing's own submission is in review (`paid_pending_review` or `changes_requested`) it has no
  other edit channel: revisions are refused and unpublishing is refused (reject it instead).
- Payment races: a draft that switched to free while its checkout was open is upgraded by the
  payment from `pending_badge`; a payment that completes after withdrawal or expiry is recorded
  with its refund (#68's webhook issues it). Any other charge the submission cannot accept lives
  only in #68's `orders`, which is the ledger of record ([Data model](./DATA_MODEL.md)). Once
  paid, the owner cannot withdraw; they message the team (#73) and an admin decides.
- The protected publisher's `listing-unpublish` can still take a listing down while its
  submission is queued (an emergency takedown is never blocked). The in-app plans refuse that,
  but after such a takedown a `changes_requested` submission cannot be resubmitted and a
  `paid_pending_review` one cannot be approved; the admin resolves it by rejecting with `live`,
  which records no second unpublish.
- Rejecting a submission with a listing (pass `live` whenever `listing_id` is set) unpublishes
  it (410) if it is still up and revokes the submitter's ownership in the same batch. A
  `prohibited` rejection blocks the registrable domain and its subdomains (or the exact host,
  for a public suffix such as `github.io`) from new free and paid submissions until an admin lifts
  the block; an `other` rejection may be submitted again as a new submission.
- Refunds (`buildRefundSubmissionPlans`) record `refunded_at`: after an `other` rejection (never
  a `prohibited` one); for an approved paid listing whose latest conclusive badge check passed in
  the last 7 days, which stays live with `plan = 'free'` (the event records that check); by
  unpublishing a live listing without such a pass; or, for a listing already down, without
  touching the catalog.
- Events (`listing_submission_events`): `created`, `plan_chosen`, `verification_failed`,
  `badge_verified`, `paid`, `edited`, `changes_requested`, `resubmitted`, `approved`,
  `rejected`, `withdrawn`, `expired`, `refunded`, `unpublished`.
- Owners edit a live listing through a revision (`listing_revisions`): `pending_review`,
  `changes_requested`, then `approved` (applied atomically to the listing), `rejected`, or
  `withdrawn` (`revision-plans.ts`).

## Review in the admin panel (#64)

Admins decide in `/admin` ([Admin panel](./ADMIN_PANEL.md)). The review queue lists
`verified` and `paid_pending_review` submissions and `pending_review` revisions, oldest first.
On a submission an admin can approve (optionally editing the name, category, short and long
description, and logo first, and choosing the outbound link; the edit and the approval are one
batch), request changes with a note, or reject with a reason and a category; on a rejected
prohibited URL, "Allow resubmission" lifts the block. Each decision is these plans with the
`content_version` guard, is idempotent (a replay answers `replayed: true` and sends nothing),
records the admin's email in the events, and emails the submitter once ("approved", "changes
requested", "rejected", or "rejected: prohibited"). Rejecting a paid submission as `other`
waits for #68's refund. These decisions write production D1 directly: the documented
production-write exception ([Admin panel](./ADMIN_PANEL.md#the-production-write-exception)).

## Submit v2 (#63)

The flow follows the approved #70 mockups (screens 2, 2b, 3). Every step needs the signed-in
owner except filling in the form; the anonymous capability-token flow is gone.

1. **`/submit/`** (screen 2). The form works signed out. Required: website, name, short
   description (160 characters at most), primary category (from D1), and logo; the long
   description is optional, and FAQs and links come later from the dashboard (#65). Signed out,
   the form is kept in this browser's `localStorage` (`bsc_submit_draft_v1`: only what was
   typed, never a token or an id), "Sign in and continue" goes to
   `/login/?callbackUrl=/submit/`, and the login card says the draft is waiting. Signed in, the
   draft moves to a key for that account (`bsc_submit_draft_v1:u:<user id>`), and signing out
   clears every draft key, so a shared browser never shows one person's draft to the next.
2. **Prefill** (`POST /api/submissions/prefill`, no AI). The Worker reads the page through the
   safe fetcher ([below](#fetching-submitters-sites)) and proposes the name (`og:site_name`,
   `application-name`, or the title), the short description (meta, `og:`, or `twitter:`
   description, shortened to 160 characters), a site icon (largest declared, 128 px or more)
   and the social image, each an https image checked as an image. All stay editable; the
   category is never filled in. It answers the URL's availability first and reads nothing for a
   duplicate or blocked URL. Its body is capped at 4 KB, and it is rate-limited in D1 per client
   address for everyone (60 an hour) and per account on top for a signed-in caller (40 an
   hour), 10 a minute each (`limits.ts`).
3. **Duplicates and blocks** use the URL key (`urlKey()`): the host is the slug and the
   duplicate key, so `brieflow.ai/pricing` counts as `brieflow.ai`. An existing listing
   (by slug, or by its exact website) offers "Claim this listing" (a link to the listing until
   #67 builds claims); a pending submission says "You already submitted" (with a link) to its
   owner and "already in review" to anyone else; an active prohibited block refuses the URL
   with its own message. The insert repeats the same checks (the active-slug index and the
   block trigger), so a race still ends in the same answer.
4. **Continue** (`POST /api/submissions`) saves a native draft per the #62 contract
   (`status = 'draft'`, `plan = NULL`, `owner_user_id`, `draft_saved_at` from this first save,
   `block_key` and `block_covers_subdomains` from `urlKey()`), after checking the logo URL is
   an https image. Draft saves count against 10 an hour per owner. The owner can edit the
   details (`PATCH /api/submissions/<id>`, `/submit/?edit=<id>`) as a draft or while waiting
   for the badge; the website never changes, and edits never reset the draft clock. Request
   bodies are capped at 32 KB as they stream in, with or without `Content-Length`.
5. **`/submit/<id>/choose/`** (screen 2b): "Get the badge code" chooses free
   (`POST /api/submissions/<id>/plan`, `draft` → `pending_badge`). The paid card and every $49
   link stay hidden while `features.showPaidListings` is off (until #68). "Decide later" leaves
   the draft in the account (`/account/` lists it with "Expires in N days" and Continue).
6. **`/submit/<id>/badge/`** (screen 3): the light and dark snippets link to the future listing.
   `POST /api/submissions/<id>/verify` first claims the check in one compare-and-swap
   (`claimVerification`: the owner's `pending_badge` submission, past the 30-second cooldown,
   under the cap of 10 conclusive checks), so parallel requests get one check and 429
   `cooldown` for the rest, and a stale result is refused with 409, never a 500. Refusals
   carry the current submission, so the page catches up (a check verified in another tab
   shows as verified). The page sends one check per click burst and keeps Verify disabled
   while it runs and through any wait the server asks for, behind its countdown. It then counts
   the fetch against an outbound budget whatever its result (20 an hour per submission, 60 per
   account, and 120 per client address, which accounts behind it share; 429 `check_budget`
   with `retryAfterSeconds`), fetches the website, decodes it as a browser would
   (`html-encoding.ts`: byte order mark, then the `Content-Type` charset, then a `<meta>` in
   the first 1024 bytes, else UTF-8; a `replacement`-encoded page, or one served as a download
   with a `Content-Disposition` other than `inline`, fails as `not_html`), and parses it
   (`parse5`, the WHATWG parser, scripting on: comments, raw text such as `script` or
   `noscript`, `template` contents and SVG or MathML content never count, and only an
   element's own attributes do).
   `bounded-html.ts` stops a page nested over 512 deep, with over 100,000 elements, or over
   its parsing-work budget, as `verification_service_error`, so 1 MB of crafted HTML costs
   tens of milliseconds, not minutes; real pages use a small part of each. It requires a
   real badge `<img>` inside an `<a>` whose own `href` is `/products/<slug>/` (badges linking to
   the old `/reviews/` URL still count) and whose own `rel` has no `nofollow`, `sponsored`, or
   `ugc`, in any case or order (`link_not_followed`, which names the tokens found; owner
   decision on #84). A page that tells search engines to skip its links fails as
   `page_not_followed`: a `nofollow` or `none` directive in `<meta name="robots">` or
   `<meta name="googlebot">`, or in an `X-Robots-Tag` header with no user-agent prefix or a
   `googlebot:` one. A rule for another crawler alone (`otherbot: nofollow`, or `bingbot`)
   does not count. A prefix covers only its own comma-separated directive: repeated headers
   arrive joined with commas, and Google applies an unprefixed one to every crawler, so
   `otherbot: noindex, nofollow` fails (`otherbot: noindex, otherbot: nofollow` does not;
   PR #84 review round 3). One followed badge link
   anywhere on the page passes. Only static HTML is read: a badge added by JavaScript fails,
   and a badge hidden with CSS passes, since detecting it would need rendering (accepted).
   Conclusive results (`badge_missing`, `link_not_followed`, `page_not_followed`,
   `wrong_destination`; rows from before #84 may hold `nofollow`) use up one of the 10 checks;
   connection problems (timeouts, HTTP errors, redirects, non-HTML) do not.
   A pass moves the submission to `verified` (the review queue) and sends "submission received"
   to the submitter and "ready for review" to `EMAIL_ADMIN_RECIPIENT`, both keyed
   `submission-verified:<id>` in the email ledger.

### Fetching submitters' sites

Badge checks, prefill, and logo checks fetch only through `apps/web/lib/submissions/safe-fetch.ts`:
every hop, including each of at most 3 manually followed redirects, must pass
`validatePublicHttpUrl` (`packages/data-ops/src/public-url.ts`: http or https, no credentials
in the URL, no `localhost`, `*.local`, `*.localhost`, `*.internal`, `*.home.arpa` or similar
names, and no private, shared, loopback, link-local, documentation, benchmark, multicast, or
reserved IPv4 or IPv6 address, including IPv4-mapped and -compatible, NAT64 `64:ff9b::/96`,
6to4 `2002::/16`, and Teredo forms); each request times out after 8 seconds; and a body is
read up to its cap (1 MB). The policy reads the URL, not DNS: a public hostname that
resolves to a private address (as `localtest.me`, which the local end-to-end fixtures use)
passes it, and production relies on Cloudflare's egress, which never reaches private ranges,
for that case.

### Logos

A logo is stored as the public https URL of an image on the submitter's site or wherever they
host it (the catalog's logos are URLs too): the site icon, the social image, or a pasted image
link, checked on save to be a PNG, JPEG, WebP, or SVG of at most 1 MB and at least 128 px on
its shorter side when its size can be read. A local Worker also accepts http, for its fixture
sites. Nothing is uploaded. The image is hotlinked, so it can change after the check: logos
render only through `<img referrerpolicy="no-referrer" loading="lazy">`, never inline, in
`<object>`, or in `<iframe>` (an SVG may contain a script), and the admin approval (#64) must
re-check the logo URL before it publishes. Copying logos into R2 (an "Upload" option, and
protection against a site changing or removing its image) needs an R2 bucket and binding,
which only the owner can create: see the owner steps in the #63 pull request.

### Draft reminders and expiry

An hourly Cron Trigger (`0 * * * *`, `triggers.crons` in `apps/web/wrangler.jsonc`) runs the
Worker's `scheduled()` handler (`apps/web/lib/worker/scheduled.ts`). Its draft job
(`apps/web/lib/submissions/draft-jobs.ts`, D1 side in `packages/data-ops/src/draft-jobs.ts`)
first sends again the draft emails whose last send failed (a `failed` email-ledger row with
attempts left, for a draft still in the state the email describes), then withdraws drafts 30
days old as `expired` and sends `draft-expired`, then claims and sends the latest due
`draft-reminder` of each remaining draft, so a reminder goes out within the hour it falls due.
Emails go out one at a time, and a D1 failure other than a lost claim fails the run. The
reminder copy follows `features.showPaidListings`: while it is off it offers the free badge
listing only, with no price, and sends a draft left in checkout to the plan choice. A run
handles at most 100 of each and logs whether more remain. The weekly badge program (#66) adds
its own cron expression and job to `scheduledJobs`. The deploy that ships the Worker registers
the trigger (the dashboard lists it under the Worker's Settings → Triggers), and each run logs
`scheduled_job_finished` or `scheduled_job_failed`. Locally, `wrangler dev --test-scheduled`
exposes `/__scheduled`; the job's behavior is covered by `scheduled.test.ts` and
`draft-jobs.test.ts` against SQLite.

## Legacy review (until #69)

The admin panel replaces the protected approver below for decisions; the notifier and the
private preview keep working until #69 retires them.

A notifier (`scripts/d1-submission-notifier.ts`) reads verified rows with no
notification entry, opens an assigned issue in this private repository, and stores its
number, URL, and a digest of a one-time draft-preview capability. The reviewer opens
the private preview link (`/admin/submissions/<id>/preview/<token>/`, uncached and
noindex; like every `/admin` page it also needs an admin session and, in production,
Cloudflare Access: [Accounts](./ACCOUNTS.md)) and then approves or rejects with
`scripts/d1-submission-approver.ts` from a protected workflow. Approval atomically promotes the staged data into the catalog and
advances the publication version; either decision revokes the preview link.

Both steps run against production D1 only:

- `notify-d1-submissions.yml` runs `pnpm db:notify:production` every 15 minutes in the
  `production-notifier` environment. It stays off until the repository variable
  `SUBMISSION_REVIEWER_GITHUB_LOGIN` names the reviewer, and it skips until that environment
  holds `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`.
- `approve-d1-submission.yml` ("Review D1 Submission") is dispatched from `main` with the
  submission UUID, `approve` or `reject`, and the confirmation
  `approve-best.serp.co-submission-production`. After reviewer approval of the `production`
  environment, it exports a D1 backup (an Actions artifact kept 30 days), runs
  `pnpm db:approve:production`, and comments on and closes the review issue.

Setup and guards are in [the deploy runbook](./DEPLOY_RUNBOOK.md#workflows).

Code: `apps/web/app/submit/`, `apps/web/components/submit/`, `apps/web/app/api/submissions/`,
`apps/web/lib/submissions/`, `packages/data-ops/src/submissions.ts`, and
`packages/data-ops/src/submission-plans.ts`.
