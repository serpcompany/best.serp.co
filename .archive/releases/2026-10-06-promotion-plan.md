# Promotion plan, 2026-10-06 (`staging` → `main`)

Promote `staging` at `81aa4a49c7` (#107) or newer to production (best.serp.co). Claims (#67, PR
#108) and payments (#68) are not merged and ship later. Read-only analysis: nothing here was run
against Cloudflare. Procedures: [Release guards](../../docs/RELEASE_GUARDS.md),
[Deploy runbook](../../docs/DEPLOY_RUNBOOK.md), [Listing media](../../docs/MEDIA.md),
[Catalog hygiene](../../docs/CATALOG_HYGIENE.md), [D1 recovery](../../docs/D1_RECOVERY.md).

**Status: done.** Promotion #121 (`main` `a91842a375`) went live on 2026-10-07 with every
catalog step in section 6 published on production (publication v11); see the
[release summary](https://github.com/serpcompany/best.serp.co/issues/59#issuecomment-6022835775).
The post-publish cleanup (section 7e) is #124.

## Blockers before the catalog steps

Neither stops the code promotion itself. Both gate the catalog steps, and each has a PR into
`staging` that must merge, with Deploy Staging green on the new head, first.

1. **Hijacked-domains could not publish on staging** (fixed by #110, the owner's option A). The
   committed manifest was pinned to publication v1, staging is past v1 through admin decisions,
   and regenerating it at another base rewrote the same id and failed
   `scripts/listing-domain-check.test.ts` ("CHECK constraint failed: valid=1"), which
   `pnpm test:d1` runs first in both publish workflows. #110 admits `listing-unpublish` with
   `expected.website` in `concurrency: rows` manifests and regenerates the manifest row-level
   (same id, same 95 operations). It applies on staging and production in any order, so
   production needs no `/admin` freeze for it. On the import, FAQs at v1, Adult at v2, then
   hijacked-domains at v3 leaves 95 listings unpublished at v4.
2. **Media objects no longer matched the plan** (fixed by #113). The first dry run failed 29 of
   3,756 objects (parts 01–06), and the publisher refuses a whole part while any object it names
   is missing. #113 reran `pnpm migration:legacy-media -- --refresh <dry-run summary>` and takes
   the result only for the 50 listings whose objects failed a dry run; every other listing keeps
   its reviewed first generation. `ezai.app`, `turnitin.com`, and `ithenticate.com` drop to the
   tile by hand, `reflectr.ai` by the generator. The plan is now 3,750 objects (439.1 MiB). Dry
   runs after: 3,750/3,750 verified, then 3,748 (a timeout and `shopify.com`'s alternating CDN
   encoding), so expect to rerun an upload until it reports `failed: []`.

## 1. What ships (`git log origin/main..origin/staging`)

24 squash commits, PRs #71, #72, #75, #74, #79, #80, #76, #83, #81, #82, #87, #92, #85, #84, #91,
#103, #102, #101, #104, #106, #96, #97, #98, #107: email (useSend), Better Auth sign-in codes,
`/account`, the admin panel, submit v2, D1 hardening, Time Travel bookmarks, the #100 manifest,
the badge program (off), hosted media with the legacy manifests, and listing FAQs. `main` has
nothing `staging` lacks: `git merge-tree --write-tree origin/main origin/staging` equals the
`staging` tree, so the staging check will match the merge commit. Deploy Staging verified
`12b2547fe3` (run 37459075006) and `81aa4a49c7` (run 37461266928), all four steps. Merging #110
and #113 moves the head: promote only once Deploy Staging is green on it.

**Migrations.** Production has only `0000_baseline`; Deploy Production applies `0001`–`0007`
(`0001` email ledger, `0002` auth tables plus the `devin@serp.co` allowlist row, `0003`
submission model, `0004` indexes, `0005` admin events and owners, `0006` badge checks, `0007`
media queue and `listing_media` columns). Rehearsed on a production proxy (sqlite 3.54,
`foreign_keys=ON`, each migration in one transaction): `0000` + the committed import
(`best-serp-co-v1.sql.br`, sha256 `3b1778da…075b` = parity `sqlChecksum`), then `0001`–`0007`:

- counts unchanged: 3,422 listings, 6,048 media, 3,777 category links, 2,254 FAQs, 2,452 links,
  141 categories, publication v1 `669f264f…0af5a`; `integrity_check` ok, `foreign_key_check`
  empty; every listing gets `source=admin`, `link_rel=follow` (the rel it renders today);
- each migration took 31–90 ms locally. The rebuilt tables (`listing_submissions`,
  `listing_owners`, `badge_checks`) are runtime tables; `listings` and `listing_media` only gain
  defaulted or nullable columns. Expect sub-second write stalls, no lock of note;
- v1 submission rows in every v1 status (`pending_badge`, `verified`, `approved`, `rejected`)
  migrate under `0003`'s new checks (synthetic rows, `plan='free'`).

The old Worker keeps working on the migrated schema except v1 `/submit` inserts, which `0003`'s
`listing_submissions_plan_chosen` check refuses: harmless for the seconds between migrate and
deploy, but it matters after a Worker rollback.

## 2. Image rendering between the deploy and the media publishes

**No new gap.** Until a media manifest repoints a listing, its rows hold the legacy URL and no
key, and the new code renders exactly what production renders today:

- the catalog reads `COALESCE(media_key, url)`, and `mediaUrl()` returns any value that is not a
  key unchanged (`packages/data-ops/src/media-keys.ts:157-160`);
- logos are a plain `<img>` that falls back to the tile on error
  (`packages/web-core/src/ui/favicon-with-fallback.tsx:70-86`), now with
  `referrerPolicy="no-referrer"` and lazy loading; featured images are a plain `<img>` without a
  fallback (`packages/web-core/src/website/website-content-section.tsx:53-60`, unchanged);
- evidence: `/products/gptzero.me/` on best.serp.co today and on staging (new code) both hotlink
  `imagedelivery.net/…/gptzero/public`, which answers 404; JSON-LD `logo` is identical.

So the window keeps today's state: hotlinks, a tile for dead logos, and a broken featured image
where the source is dead (4,359 imported rows answer 404, per the legacy media report). No
temporary render path is needed; the fix is to close the window promptly. **Window length:**
Deploy Production about 8–10 min plus approval (the last one ran 8 min); the production upload
copies 3,750 objects with three R2 REST calls each (about 11,300 calls, 6 workers, 60-min job
timeout). If Cloudflare's API limit of 1,200 requests per 5 minutes applies to the token, that is
at least 47 min and may need a rerun (a rerun skips what is present). Then 10 publishes of
about 4–6 min each, run one after another. Expect **1.5–2.5 hours** from deploy to the last
media part; hijacked-domains, FAQs, and Adult do not depend on the upload and go first.

## 3. Feature flags on `81aa4a49c7` (`apps/web/lib/features.ts:47-54`)

| Flag | Value | Live in production because of it |
|---|---|---|
| `accountDashboard` | `true` (code constant) | `/login`, `/account` (submissions, listings, edit, revisions), submit v2 drafts; emails link there |
| `listingFaqs` | `true` (#107) | FAQ section on listing pages; account says "Shown on your listing page." |
| `badgeProgram` | `false`; **`true` since #130** | At promotion: crons ran but returned `{enabled:false}`, and no page or email promised weekly checks. Since #130: the crons check badges ([Badge program](../../docs/BADGE_PROGRAM.md)), and the weekly-check copy shows |
| `claims` | `false`; **`true` since #130** | At promotion: no claim link, and no claim offers in emails. Since #130: "Claim this listing" on every listing without an owner, by the badge (and a payment since #133) ([Claims](../../docs/CLAIMS.md)) |
| `orders` | `false`; **`true` since #133** | At promotion: `/admin/orders/` 404, no paid plan, upgrade, Relist, paid claim, or claim-again offers. Since #133: the $49 paid plan at submit, Upgrade and Relist in the account, paid claims, claim-again and paid offers in emails, admin Orders, and the hourly billing sweep, which needs production's live secrets ([Billing](../../docs/BILLING.md#configuration-owner)) |
| `messages` | `false` | Emails and the claim dialog point to `/contact/` (200) |

#130 turns `badgeProgram` and `claims` on after this promotion, and #133 `orders` (owner
decisions, 2026-10-07), for production with a later promotion; the rows above keep what this
one shipped and say what changed.

`site.features.showPaidListings` is `false` (`packages/site-config/src/site.ts:54`), so submit
offers only the free plan (since #68 the paid plan follows `features.orders` instead). Nothing promises an unbuilt feature (`feature-copy.test.ts`,
`links.test.ts`). Note: sign-in and submissions open to the public, and `/admin` writes
production D1 from the Worker ([Admin panel](../../docs/ADMIN_PANEL.md)).

**FAQs before the #105 manifest:** `faqsToShow()` hides an FAQ whose `### <question>` heading
the description still holds after its last `## FAQ` line
(`packages/web-core/src/website/website-faqs-section.tsx:23-35`), so the 335 imported listings
never show FAQs twice. The manifest removes those blocks; the net is then a no-op.

## 4. Crons that start in production (`apps/web/wrangler.jsonc:100-102`)

| Cron | Jobs (`apps/web/lib/worker/scheduled.ts:176-181`) | With flags as shipped |
|---|---|---|
| `0 * * * *` | draft reminders and expiry; badge program | Drafts: always on (no drafts yet; later sends real reminder emails, free-plan copy). Badge: `{enabled:false}`, reads nothing (since #130: continues the weekly cycle and rechecks in batches). Since #68 the billing sweep runs last: `{enabled:false}` until #133, then it needs the live secrets |
| `15 3 * * 1`, `45 3 * * *` | badge program weekly cycle, daily rechecks | `{enabled:false}` (since #130: runs, `{enabled:true}` with its counts) |
| `*/15 * * * *` | listing media: due slots, ten per run; deletes finished submission images | Queue empty after `0007`; hosts admin logo edits and approvals into `cdn` under `best.serp.co/` |

## 5. Production prerequisites

| Item | Code requires | Status |
|---|---|---|
| `BETTER_AUTH_SECRET` | Worker secret, ≥ 32 chars, else `/api/auth/*` 503 | Owner set it on both Workers (issue #60 comment, 2026-10-05). **Owner check:** `pnpm exec wrangler secret list --env production --config apps/web/wrangler.jsonc` |
| `USESEND_API_KEY` | Worker secret, else email disabled and logged | Done per [Email](../../docs/EMAIL.md#owner-prerequisites) step 1. **Owner check:** the production key is restricted to `mail.serp.co` (only staging's is confirmed) |
| Sending domain | `noreply@mail.serp.co` | **Owner check:** EMAIL.md steps 3–4 (domain verified, DKIM and DMARC pass) are not marked done |
| Access on `/admin` | `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD` vars | Verified: best.serp.co/admin/ answers 302 to `serpcompany.cloudflareaccess.com` with the AUD in `wrangler.jsonc:90` |
| `MEDIA` → `cdn` | binding, `MEDIA_BASE_URL=https://cdn.serp.co` | In `wrangler.jsonc:112-117`; cdn.serp.co answers 404 for an absent key; code writes only `best.serp.co/` keys |
| Deploy token R2 | Workers R2 Storage → Edit; production reads `cdn-staging` | MEDIA.md says done; staging deployed with its binding. **Owner check:** the `production` environment's token is that same token |
| Upload rate | ~11,300 R2 API calls | **Owner check:** the token's API rate limit (see section 2) |

## 6. Catalog publications

| Order | Manifest | Mode | Needs upload |
|---|---|---|---|
| 1 | `2026-10-06-hijacked-domains.yaml`: unpublish 95 (32 gambling or spam, 63 parked) | rows (#110) | no |
| 2 | `2026-10-06-listing-faqs.yaml`: trim 335 descriptions | rows, whole batch | no |
| 3 | `2026-10-06-legacy-media-adult-category.yaml`: Adult on 14 listings | rows | no |
| 4–10 | `2026-10-06-legacy-media-01` … `-07.yaml`: 3,199 listings (#113) | rows | yes |

After #110 and #113 every manifest is row-level: the same files apply on staging and production
in any order, and the table order is only a convention (the ones that need no upload first).
`pnpm test:d1` passes on both branches. Before publishing on staging, read its state read-only:

```bash
pnpm exec wrangler d1 execute best-serp-co-staging --env staging --remote --json \
  --config apps/web/wrangler.jsonc --command \
  "SELECT version, checksum, manifest_id, published_at FROM publication_state"
pnpm exec wrangler d1 execute best-serp-co-staging --env staging --remote --json \
  --config apps/web/wrangler.jsonc --command \
  "SELECT (SELECT COUNT(*) FROM listing_media WHERE media_key IS NOT NULL) AS hosted_rows,
   (SELECT COUNT(*) FROM publication_runs WHERE workflow='app/admin') AS admin_publications"
```

`hosted_rows` above 0 means admin logo edits: those listings will refuse their media part. A
row-level manifest needs regeneration only if staging refuses it (it writes nothing):
media via `--current <dir> --manifest-id 2026-10-07-legacy-media`
([recovery](../../docs/MEDIA.md#recovering-a-refused-media-manifest)); FAQs via
`pnpm catalog:faqs -- manifest --skip <slug> --manifest-id 2026-10-07-listing-faqs-staging`.
Production then publishes exactly the manifests staging published.

## 7. Runbook

Agents prepare PRs and run read-only checks; the owner dispatches every workflow, staging
included ([Credential guards](../../docs/CREDENTIAL_GUARDS.md#security-boundary), MEDIA.md). Each publish
writes its Time Travel bookmark and restore command to the run summary: record it.

### a. Staging

- **S0.** Owner merges #110 and #113 into `staging`; wait for Deploy Staging to go green on the
  new head, and run the read-only queries in section 6.
- **S1.** Upload Listing Media (staging):
  `gh workflow run upload-media-staging.yml --ref staging -f plan_path=d1/media/2026-10-06-legacy-media.json -f confirmation=upload-media-best.serp.co-staging`.
  Require `failed: []` in the summary; rerun (it skips present objects) for 429s, timeouts, or
  a flapping source. A source that changed for good: refresh it as #113 did.
- **S2.** Publish D1 Catalog (staging), once per manifest in section 6 order:
  `gh workflow run publish-d1-staging.yml --ref staging -f manifest_path=d1/publications/<file> -f confirmation=publish-best.serp.co-staging`.
- **S3.** Accept staging: `MEDIA_ACCEPTANCE=1
  PLAYWRIGHT_BASE_URL=https://best-serp-co-staging.serpcompany.workers.dev
  PLAYWRIGHT_EXTERNAL_SERVER=1 pnpm --filter e2e exec playwright test
  tests/listing-media-acceptance.spec.ts --project=chromium`; `/products/autoportrait.ai/` answers
  410; `/products/123movies-downloader/` shows its FAQs once and no `## FAQ` in the description;
  `alphaporno-downloader` lists under `/products/categories/adult/`.

### b. Promotion

- **P1.** Owner: `gh pr create --base main --head staging`, then merge with **Create a merge
  commit** after PR Review.
- **P2.** The push runs **Deploy Production**: `authorize` checks the staging-verified tree, the
  `production` reviewers approve, then `harness:fast`, build, `plan-release` (pending `0001`–`0007`
  → bookmark → migrate), deploy, HTTP gates. Record the bookmark and the previous Worker version
  (`x-worker-version` today: `59ce19ef-d561-4e0f-b654-52bbb55e5e12`). A dispatch re-run needs
  `deploy-best.serp.co-production`.

### c. Production

- **P3.** Right after the merge (own concurrency group, may run during P2): Upload Listing Media
  `gh workflow run upload-media.yml --ref main -f plan_path=d1/media/2026-10-06-legacy-media.json -f confirmation=upload-media-best.serp.co-production`;
  `production` reviewers approve. It copies from `cdn-staging`.
- **P4.** After P2: Publish D1 Catalog, hijacked-domains,
  `gh workflow run publish-d1.yml --ref main -f manifest_path=d1/publications/2026-10-06-hijacked-domains.yaml -f confirmation=publish-best.serp.co-production`.
- **P5.** Same workflow for listing FAQs, then Adult category; after P3 shows `failed: []`, media
  parts 01–07.
- **P6.** Accept: `pnpm db:migrations:list:production` (none pending);
  `pnpm tsx scripts/d1-preview-http-gates.ts public https://best.serp.co`; the S3 checks with
  `PLAYWRIGHT_BASE_URL=https://best.serp.co`; `/admin/` 302 to Access; `/login/` 200 and a
  sign-in code reaches an inbox (DKIM and DMARC pass). Avoid `/admin` logo edits until the media
  parts are published: an edited listing refuses its part.

### d. Rollback

| Step | Rollback (owner) |
|---|---|
| S1, P3 upload | Nothing to undo: objects are unreferenced until a manifest names them |
| S2, P4, P5 publish | Fix forward in `/admin` (Republish) or `wrangler d1 time-travel restore <db> --env <env> --config apps/web/wrangler.jsonc --bookmark <run bookmark>` ([restore](../../docs/D1_RECOVERY.md#restore)); a restore loses every later write |
| P2 deploy | Worker first: `pnpm exec wrangler rollback 59ce19ef-d561-4e0f-b654-52bbb55e5e12 --env production --config apps/web/wrangler.jsonc`, then D1 to the deploy run's first-attempt bookmark, and do not re-release `main` until a fix is promoted ([bad migration](../../docs/D1_RECOVERY.md#undo-a-bad-migration)) |

The old Worker reads `listing_media.url`, so after media publishes it hotlinks the recorded
sources as today; it shows unpublished listings as 404 instead of 410, and after the FAQ trim it
shows no FAQs (it has no FAQ section).

### e. Who does what

- **Owner only:** every dispatch above (staging and production), the typed confirmations
  `upload-media-best.serp.co-staging`, `publish-best.serp.co-staging`,
  `upload-media-best.serp.co-production`, `publish-best.serp.co-production`, and
  `deploy-best.serp.co-production` (dispatch only), the `production` approvals, the promotion
  merge, any restore or rollback, and the owner checks in section 5.
- **Agents, with the owner's go-ahead:** the blocker PRs (#110, #113), read-only
  queries and dry runs, the S3 and P6 acceptance checks, and the post-publish cleanup PR
  (#124: deleted `apps/web/public/listing-logos/serpdownloaders.com/`, `listing-media-seed/`, and
  `media/products/launchbuzz.io/` after read-only queries found every production and staging
  row hosted; MEDIA.md [Legacy migration](../../docs/MEDIA.md#legacy-migration)).
