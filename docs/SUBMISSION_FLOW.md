# Submission flow

The public `/submit` page queries active categories from D1. Its client form sends a
validated request to `POST /api/submissions`, which writes the submission, resource
links, FAQs, and creation event to normalized D1 staging tables. The response includes
an opaque capability token; only its SHA-256 digest is stored. The submit page
immediately replaces the form with a visible saved-submission receipt. It retains the
capability in browser storage and a URL fragment, allowing the submitter to close the
badge dialog, reload, return later in the same browser, or bookmark/copy a private
resume link. The fragment is not sent with the initial HTTP request.

The submitter installs either generated badge and selects **Verify installed badge**.
`POST /api/submissions/<id>/verify` authenticates the capability, enforces attempt and
cooldown limits, and performs a bounded server-side fetch of the submitted public
website. Verification succeeds only when the expected badge image links to the future
listing URL without `nofollow`. Successful verification changes the staging status to
`verified`; it does not make the listing public. The form tells the submitter that the
administrator will be notified within a few minutes.

When the Site has an active Production cutover lock, public intake, its rate-limit
update, and the final badge-verification transition return `503 cutover_frozen`.
Their D1 batches assert the lock atomically, so a frozen request changes no
rate-limit, Submission, or event row. The notifier checks the same lock before any
GitHub issue lookup/create/update and before recording its D1 delivery ledger.

The verifier loads the exact submitted website URL and scans the HTML returned by
that request. The form identifies that URL and explains that a badge inserted only
after client-side JavaScript runs cannot be detected. A successful HTML fetch with no
badge is reported as **Page reached — badge not found**. Connection failure, timeout,
HTTP status, redirect failure, non-HTML content, oversized HTML, wrong link target,
and `nofollow` are separate outcomes with specific remediation; raw internal codes
are not shown to submitters.

The ten-attempt limit counts successful checks and conclusive HTML scan failures
(`badge_missing`, `nofollow`, and `wrong_destination`). Transient connection,
timeout, HTTP, redirect, response-format, and verifier-service failures still update
the last-check time and remain subject to the 30-second cooldown, but they do not
consume a content-verification attempt.

Restoring a saved verification session calls the capability-protected submission
status endpoint and rebuilds the badge instructions from D1 state. Successful
verification clears the saved resume capability. A copied resume link is a bearer
secret and must remain private.

A scheduled and manually dispatchable
`.github/workflows/notify-d1-submissions.yml` reads verified rows that have no
notification ledger entry. It creates or recovers one issue in the private
`serpcompany/directory-platform-d1` repository, assigns the reviewer configured in
`SUBMISSION_REVIEWER_GITHUB_LOGIN`, and stores the issue number and URL in
`listing_submission_notifications`. The notifier also generates a single 256-bit
draft-preview capability. Its SHA-256 digest is stored in the notification row; the
raw capability appears only in the assigned issue's private preview link. The issue
contains the normalized submission, badge timestamp, and review instructions, but D1
remains authoritative.

The reviewer opens that link to render the staged row through the same listing-detail
view used by public products. The server-only preview repository requires the exact
registered site tenant, a matching capability digest, the GitHub notification
channel, and `verified` status. Invalid or expired links return the generic not-found
page. The route is dynamic, uncached, excluded from indexing, emits no listing
structured data, and is absent from navigation and sitemaps. Approving or rejecting
the submission changes its status and therefore revokes the link without publishing
the staging route.

The assigned maintainer reviews the issue and manually runs
`.github/workflows/approve-d1-submission.yml` from `main`. The reviewer selects
`serp.software` or `pornvideodownloaders.com`; the workflow requires the exact
`approve-<site-id>-submission-production` confirmation and that site's protected
production environment. It retains a pre-change D1 export, applies migrations,
verifies that the row belongs to the selected tenant and is badge-verified,
atomically promotes its normalized data into that catalog, and records publication
and submission audit events.
The same protected workflow can reject a pending or verified row without creating a
listing. After either successful decision, it comments on and closes the matching
review issue. The draft link then stops working.

The public form is implemented in
`packages/web-core/src/forms/d1-submission-form.tsx`. Each Site's server-only adapter
at `apps/<site-id>/lib/submissions/repository.ts` only validates its OpenNext binding,
runtime environment, and Site identity before calling the shared operations in
`packages/data-ops/src/submissions.ts`. Protected approval and notifier scripts use
pure shared statement plans but retain exclusive credential and remote-mutation
authority. Submission intake does not use GitHub Issues or catalog files as data
sources; an assigned private issue is only the admin notification and inbox.
