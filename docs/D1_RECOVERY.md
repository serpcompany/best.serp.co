# D1 recovery with Time Travel

Production D1 changes in two ways. The protected workflows (deploy, publish, approve) export a
backup first ([Deploy runbook](./DEPLOY_RUNBOOK.md#backups-and-recovery)). The admin panel
(serpcompany/best.serp.co#64) writes from the Worker on each decision and takes no backup, so
**D1 Time Travel** is how a wrong admin write is undone ([Admin panel](./ADMIN_PANEL.md)).

Time Travel keeps a point-in-time history of every D1 database: 30 days on the Workers Paid
plan. It restores the whole database in place to a moment (a Unix timestamp, an RFC 3339 time,
or a bookmark), so every write after that moment is lost, not only the bad one.

**Who runs it.** Only the owner, from a terminal signed in with `wrangler login` (or a token
with D1 Edit), after deciding the restore is worth losing the later writes. No workflow or
agent restores production. Practise on staging (`best-serp-co-staging`, `--env staging`) first.

## Before restoring: fix forward if you can

Most admin mistakes have an undo in the panel itself, which keeps every later write:

| Mistake | Undo in the panel |
|---|---|
| Unpublished by mistake | Listings → the listing → Republish |
| Wrong outbound link | Listings → the listing → Outbound link |
| Wrong owner | Listings → the listing → Transfer (or Remove owner) |
| Wrong listing details | Listings → the listing → Details → Save changes |
| Prohibited block by mistake | Listings or the submission → Allow resubmission |
| Admin removed | Admins → Add an admin |

An approval, a rejection, and a change request cannot be reversed in the panel (the submission
statuses are final or wait on the submitter). Restore only when fixing forward is not possible.

## Find the moment

1. Find the bad write and its time (UTC). Every admin decision is recorded with the admin's
   email: in `listing_submission_events` (`actor`, `created_at`), `listing_revision_events`,
   `listing_events`, and, when it changed the catalog, `publication_runs` (`actor`,
   `workflow = 'app/admin'`, `started_at`, `manifest_id`). For example, read-only:

   ```bash
   pnpm exec wrangler d1 execute best-serp-co-production --env production --remote \
     --config apps/web/wrangler.jsonc --command \
     "SELECT id, manifest_id, actor, started_at FROM publication_runs ORDER BY started_at DESC LIMIT 20"
   ```

2. Pick a moment just before it, and look up its bookmark:

   ```bash
   pnpm exec wrangler d1 time-travel info best-serp-co-production --env production \
     --config apps/web/wrangler.jsonc --timestamp 2026-10-06T10:41:00Z
   ```

## Restore

1. Write down the current bookmark first (`time-travel info` without `--timestamp`), so the
   restore itself can be undone.
2. Restore:

   ```bash
   pnpm exec wrangler d1 time-travel restore best-serp-co-production --env production \
     --config apps/web/wrangler.jsonc --timestamp 2026-10-06T10:41:00Z
   ```

   Wrangler prints the previous bookmark; keep it with the one from step 1.
3. Check the result read-only (`pnpm db:migrations:list:production`, and the rows from "Find
   the moment"). If the restore went to a time before a migration, that migration is pending
   again: the next Deploy Production applies it (it backs up first).
4. Public pages are cached under the catalog epoch (`publication_state.version` plus the newest
   public `published_at`), not the checksum. A restore moves the version back, so the next
   publications reuse version numbers that were already used before the restore, and the edge
   HTML cache and the data cache could serve pages stored under them for up to 24 hours.
   Redeploy the Worker right after a restore (Deploy Production): a new Worker version starts
   with a cold edge HTML cache. The data cache survives deploys and expires within 24 hours;
   in that window, an epoch that repeats a pre-restore one (same version and same newest
   `published_at`) can show the data cached before the restore. A new approval gives a new
   `published_at`, and so a new epoch.

To undo the restore, run `time-travel restore` again with the bookmark from step 1.

## Staging

Staging has the same history. Rehearse with `--env staging` and `best-serp-co-staging`; staging
has no protected-data concerns, but the same "every later write is lost" rule applies.
