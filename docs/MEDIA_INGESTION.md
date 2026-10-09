# Media ingestion

How the Worker turns a source URL into a hosted listing image, where it does so, and how the
media cron retries what it could not host at once. Keys, storage, and rendering:
[Listing media](./MEDIA.md).

## Fetching and checking a source

`apps/web/src/db/media-ingest.ts` fetches a source through the one shared `safeFetch`, which
submit v2's badge checks and prefill use too
([Submission flow](./SUBMISSION_FLOW.md#fetching-submitters-sites)): every hop is checked by
`validatePublicHttpUrl`, redirects are few, each request has a timeout and a byte cap, the
response type is read as Fetch reads it, and media fetches use only ports 80 and 443.

An image is recognized by its bytes, never by a declared type or file name, and its structure is
checked to the end of the file (`media-format.ts`), so a header-only stub or a header glued to
other bytes is refused. SVG, an image over the pixel cap, and anything that is not one of the
hosted raster formats are refused. The bytes are stored under their key, and
`media-operations.ts` records the result in D1 with statement plans.

The Worker relies on Cloudflare's egress, which never reaches private addresses, for a public
name that resolves to a private one. A Node script (the migration, the upload) may run on a
self-hosted runner or a laptop, next to private services, so it passes `nodeFetch`
(`safe-fetch-node.ts`): each hop's connection resolves its host once, refuses it unless every
address is public by the same `public-url.ts` policy, and connects to exactly the checked
address, so DNS rebinding cannot swap it; `Host` and TLS SNI stay the host's.

## Where it runs

- **Submissions.** Saving a submission hosts its logo under `submissions/<id>/` after the
  response (`hostSubmissionImages`), and its featured image: the social image the server's own
  prefill finds on the submitted website, never a URL the client sends. A changed logo or image
  replaces the copy, and the superseded, never-reviewed object is deleted unless a slot still
  names it (submissions and revisions alike). Intake refuses SVG logos and prefill skips SVG
  icons. Nothing here can fail the save.
- **Admin listing edit.** `updateListingDetails` hosts a changed logo before its batch. A logo
  that can never be hosted (SVG, not an image, 404, too large) is refused with a 422 that names
  the reason, and nothing is saved. A retryable failure saves, the screen warns with the reason
  instead of "Saved", the source is queued, and a hosted current logo stays until the new one
  lands. While it waits, the form shows the queued source and the preview the current logo;
  saving the current logo's URL again cancels the queued replacement.
- **Owner revisions.** Saving a revision whose logo differs from the listing's hosts it under
  `revisions/<id>/` after the response (`hostRevisionLogo`). A revision that keeps the listing's
  logo needs no copy. Resubmitting a submission with a changed logo replaces its hosted copy, as
  saving a changed logo on the submit form does.
- **Approvals publish only what the reviewer saw** (`adoptStagedLogoPlans` and
  `adoptSubmissionImagePlans` hold the rules). The review screen and both previews show the
  hosted logo and featured image; the approval sends those keys back and is refused if either
  changed since. A listing logo row of the staged source is kept when it holds those bytes, or
  is an imported row; otherwise the reviewed copy (the submission's or the revision's) is queued
  for a copy into the listing's path. A logo or image that was not hosted at review is never
  fetched later. With no reviewed logo to adopt, a revision or claim approval keeps the
  listing's current logo, row, and queue; a new listing shows the fallback tile until an admin
  sets one. A paid listing going live at payment copies only what is hosted then. The approval
  copies right after its response.
- **Reviewed copies only.** A slot copied from a submission is filled only with the reviewed
  bytes: an R2 error retries the copy; if the reviewed object is gone, a refetch is accepted
  only when its content hash is the reviewed key's, and otherwise the slot fails
  (`reviewed_copy_changed`, `reviewed_copy_missing`, recorded on the slot and in the logs).
- **The media cron** (the `listing-media` job, every 15 minutes) retries due slots a few at a
  time, each claimed with a lease so a slot comes due again if its run dies, then deletes
  finished submissions' and revisions' images. A retryable failure (the source may answer next
  time: a timeout, an unreachable host, 408, 429, 5xx, a failed write) backs off on a growing
  schedule; once the attempts run out, or on any other failure (404, SVG, too large, not an
  image), the slot is `failed`. The schedule, batch size, and lease are in
  `apps/web/src/db/media-plans.ts`.

## The cron never overwrites a newer write

A cron write applies only while its claim holds: the claimed row (id, lease, source) is still
there, and the listing's slot still holds what it held when the run read it. An admin edit, an
approval, or a publication that touches the slot meanwhile deletes or reschedules the row or
changes the slot, so the cron's result (hosted or failed) is refused inside its batch and
counted as `superseded`, never retried, and the queue row is not re-created. The media plan and
operation tests reproduce the race.
