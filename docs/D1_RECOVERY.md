# D1 recovery with Time Travel

Production D1 changes in two ways. The protected workflows (deploy, publish, approve)
record a Time Travel bookmark first, in the run summary
([Deploy runbook](./DEPLOY_RUNBOOK.md#bookmarks-and-recovery)). None exports the database: this
repository is public, so any signed-in GitHub user could download an export uploaded as an
Actions artifact, with its sessions, OAuth tokens, and emails (#99). The admin panel
(serpcompany/best.serp.co#64) writes from the Worker on each decision and records no bookmark,
so a wrong admin write is undone by restoring to a moment ([Admin panel](./ADMIN_PANEL.md)).
Either way, **D1 Time Travel** is the only recovery.

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

## Restore a workflow bookmark

Every workflow step that changes D1 (Deploy Staging and Deploy Production migrations, Publish D1
Catalog, Review D1 Submission) comes right after a step that runs
`cloudflare-release.ts bookmark <env>`. If that step cannot read a bookmark, the job fails before
the change. Otherwise the run summary shows the bookmark, when it was recorded, and the exact
command, for example:

```bash
pnpm exec wrangler d1 time-travel restore best-serp-co-production --env production \
  --config apps/web/wrangler.jsonc --bookmark <bookmark>
```

The bookmark is the database just before that run changed it. Restoring it also discards every
later write, including the Worker's own (sessions, sign-ins, submissions, admin decisions). A
bookmark is not a secret: using it requires D1 Edit on the SERP account. Bookmarks older than
the 30-day window cannot be restored.

**Use the first attempt's bookmark.** A change can be partly committed when its step fails:
`wrangler d1 migrations apply` commits each migration on its own, so a release that failed on
its second migration keeps the first. "Re-run failed jobs" then records a new bookmark that
already includes it. Open the run, pick the earliest attempt in the attempt menu whose summary
shows a bookmark, and use that one. The same goes across runs: a new dispatch after a failed run
records its bookmark after whatever the failed run committed.

Which procedure:

- A Deploy Production bookmark (a migration ran after it): [Undo a bad
  migration](#undo-a-bad-migration). Restoring D1 alone and redeploying would apply the same
  migration again.
- Any other bookmark (Publish D1 Catalog, Review D1 Submission): follow
  [Restore](#restore) below with the bookmark in step 2, then [After a restore](#after-a-restore).

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

1. Write down the current bookmark (`time-travel info` without `--timestamp`), so the
   restore itself can be undone.
2. Restore (to a workflow bookmark, use `--bookmark <bookmark>` instead of `--timestamp`):

   ```bash
   pnpm exec wrangler d1 time-travel restore best-serp-co-production --env production \
     --config apps/web/wrangler.jsonc --timestamp 2026-10-06T10:41:00Z
   ```

   Wrangler prints the previous bookmark; keep it with the one from step 1.
3. Check the result read-only (`pnpm db:migrations:list:production`, and the rows from "Find
   the moment"). If the restore went to a time before a migration, that migration is pending
   again and the next Deploy Production applies it: stop and follow [Undo a bad
   migration](#undo-a-bad-migration) instead of step 4.
4. Public pages are cached under the catalog epoch (`publication_state.version` plus the newest
   public `published_at`), not the checksum. A restore moves the version back, so the next
   publications reuse version numbers that were already used before the restore, and the edge
   HTML cache and the data cache could serve pages stored under them for up to 24 hours.
   When no migration is pending, redeploy the Worker right after a restore (Deploy Production
   plans `worker-only`): a new Worker version starts with a cold edge HTML cache. The data
   cache survives deploys and expires within 24 hours; in that window, an epoch that repeats a
   pre-restore one (same version and same newest `published_at`) can show the data cached
   before the restore. A new approval gives a new `published_at`, and so a new epoch.

To undo the restore, run `time-travel restore` again with the bookmark from step 1.

## Undo a bad migration

Deploy Production applies pending migrations, then deploys the new Worker. Each migration must
stay compatible with the Worker that was live while it applied, so the previous Worker runs on
both the migrated and the restored schema; the new Worker may not run on the restored one.
Hence the order:

1. **Roll the Worker back first** to the version that was live before the release:

   ```bash
   pnpm exec wrangler deployments list --env production --config apps/web/wrangler.jsonc
   pnpm exec wrangler rollback <previous-version-id> --env production \
     --config apps/web/wrangler.jsonc
   ```

2. **Restore D1** to the release run's bookmark, from its first attempt (see above), with
   [Restore](#restore) steps 1 to 3. Skip step 4's redeploy, but not its warning: the rollback
   gives the HTML cache a different Worker version, while the data cache is keyed by the catalog
   epoch only. Publications made between the release and the restore created epochs that the
   next publications reuse, so data cached from the discarded writes can show for up to 24
   hours.
3. **Don't release `main` again until the fix is promoted.** The restore removed the migration
   from the `d1_migrations` ledger, but `main` still has its file, so `plan-release` finds it
   pending: any Deploy Production of `main` (a push, a re-run, or a dispatch) plans
   `database-and-worker`, records a new bookmark, and applies the same migration again. The
   hotfix path cannot ship around it either: `plan-release` refuses a hotfix while migrations
   are pending ([Release guards](./RELEASE_GUARDS.md#hotfixes)). Reject every Deploy Production
   run that waits for approval until then.
4. **Fix forward through `staging`.** If running the bad migration again is harmless once a
   corrective migration follows it, add that migration in a pull request into `staging` and
   promote it. If it is not (it destroys data), production must never apply it. That means
   changing a migration `staging` already applied, against the forward-only rule, so it is the
   owner's decision; staging's D1 then needs the same restore before Deploy Staging can verify
   the fixed tree.
5. Do [After a restore](#after-a-restore).

## After a restore

A restore rewinds D1 only. Then:

- **Admin decisions after the bookmark.** An approval or rejection is undone, and the
  submission is back in its state at the bookmark (usually badge-verified, so it is in the
  review queue again). Decide again in the admin panel, or tell the submitter.
- **Emails already sent stay sent.** The `email_deliveries` ledger forgot them, so a repeated
  decision emails again. Tell submitters whose submissions or edits were lost to submit again.
- **Accounts and sign-ins after the bookmark are gone.** Those users sign in again.

## Staging

Staging has the same history. Rehearse with `--env staging` and `best-serp-co-staging`; staging
has no protected-data concerns, but the same "every later write is lost" rule applies.
