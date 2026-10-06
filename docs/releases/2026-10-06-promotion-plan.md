# Promotion plan, 2026-10-06 (`staging` → `main`)

Promote `staging` at `81aa4a49c7` (#107) or newer to production (best.serp.co). Claims (#67, PR
#108) and payments (#68) are not merged and ship later. Read-only analysis: nothing here was run
against Cloudflare. Procedures: [Release guards](../RELEASE_GUARDS.md),
[Deploy runbook](../DEPLOY_RUNBOOK.md), [Listing media](../MEDIA.md),
[Catalog hygiene](../CATALOG_HYGIENE.md), [D1 recovery](../D1_RECOVERY.md).

## Blockers and decisions before the first step

1. **The hijacked-domains manifest cannot publish on staging as committed.** It is a
   `publication`-mode manifest at base version 1 (`2026-10-06-hijacked-domains.yaml:9-13`), and
   staging has moved past v1 through admin activity. `pnpm catalog:domains -- manifest --date
   2026-10-06 --base-version <V> --base-checksum <C>` rewrites the same file and id (there is no
   `--manifest-id`), so it no longer fits production at v1, and it fails
   `scripts/listing-domain-check.test.ts` ("CHECK constraint failed: valid=1", reproduced here),
   which runs in `pnpm test:d1`, the first step of both publish workflows. Choose one:
   - **A (recommended):** a small PR into `staging` that admits `listing-unpublish` in
     `concurrency: rows` manifests (its per-row guards already hold: categories, live, website,
     no submission in review; `scripts/d1-publisher.ts:269-285` rejects it today, and
     CATALOG_HYGIENE "The report and the manifest" anticipates this) and regenerates the manifest
     row-level. One file then fits both environments in any order, which also removes blocker 2.
   - **B:** the owner waives staging-first for #100 only: publish the committed manifest on
     production first after the deploy (base v1 holds there), and unpublish on staging later.
2. **Production must publish hijacked-domains before any other catalog write** (without A).
   Production is at publication v1: no Publish D1 Catalog or Review D1 Submission run ever ran,
   and main has no admin panel. After Deploy Production, any `/admin` decision or row-level
   publish advances the version and the v1 manifest is refused. Freeze `/admin` until step P4.
3. **29 of 3,756 media objects no longer match the plan.** `pnpm media:upload:dry-run -- d1/media/
   2026-10-06-legacy-media.json` (3 min 28 s, writes nothing): 3,727 verified, 29 failed (20
   changed bytes or SHA-256, 7 `http_403`, 2 `fetch_timeout`). They sit in parts 01–06 (5, 7, 4,
   5, 6, 2); the publisher refuses a whole part when any key is missing from the bucket, so only
   part 07 and the Adult category would publish. Fix before the staging upload: rerun the dry run
   (the 403s and timeouts may be transient), then `pnpm migration:legacy-media -- --refresh
   <dry-run summary JSON>`, review the diff, and merge it into `staging`. The fetch cache
   (`.runtime/legacy-media-cache`) is not on this machine, so the regeneration refetches every
   source unless it runs where the cache is; review the whole diff either way.

None of these stops the code promotion itself. They gate the catalog steps.

## 1. What ships (`git log origin/main..origin/staging`)

24 squash commits, PRs #71, #72, #75, #74, #79, #80, #76, #83, #81, #82, #87, #92, #85, #84, #91,
#103, #102, #101, #104, #106, #96, #97, #98, #107: email (useSend), Better Auth sign-in codes,
`/account`, the admin panel, submit v2, D1 hardening, Time Travel bookmarks, the #100 manifest,
the badge program (off), hosted media with the legacy manifests, and listing FAQs. `main` has
nothing `staging` lacks: `git merge-tree --write-tree origin/main origin/staging` equals the
`staging` tree, so the staging check will match the merge commit. Deploy Staging verified
`12b2547fe3` (run 37459075006, all four steps); `81aa4a49c7` (run 37461266928) was still running
when this was written, and must be green before the promotion.

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
copies 3,756 objects with three R2 REST calls each (about 11,300 calls, 6 workers, 60-min job
timeout). If Cloudflare's API limit of 1,200 requests per 5 minutes applies to the token, that is
at least 47 min and may need a rerun (a rerun skips what is present). Then 9 or 10 publishes of
about 4–6 min each, run one after another. Expect **1.5–2.5 hours** from deploy to the last
media part; hijacked-domains, FAQs, and Adult do not depend on the upload and go first.

## 3. Feature flags on `81aa4a49c7` (`apps/web/lib/features.ts:47-54`)

| Flag | Value | Live in production because of it |
|---|---|---|
| `accountDashboard` | `true` (code constant) | `/login`, `/account` (submissions, listings, edit, revisions), submit v2 drafts; emails link there |
| `listingFaqs` | `true` (#107) | FAQ section on listing pages; account says "Shown on your listing page." |
| `badgeProgram` | `false` | Crons run but return `{enabled:false}`; no page or email promises weekly checks |
| `claims` | `false` | No claim offers in emails |
| `orders` | `false` | `/admin/orders/` 404, no paid upgrade or Relist offers |
| `messages` | `false` | Emails point to `/contact/` (200) |

`site.features.showPaidListings` is `false` (`packages/site-config/src/site.ts:54`), so submit
offers only the free plan. Nothing promises an unbuilt feature (`feature-copy.test.ts`,
`links.test.ts`). Note: sign-in and submissions open to the public, and `/admin` writes
production D1 from the Worker ([Admin panel](../ADMIN_PANEL.md)).

**FAQs before the #105 manifest:** `faqsToShow()` hides an FAQ whose `### <question>` heading
the description still holds after its last `## FAQ` line
(`packages/web-core/src/website/website-faqs-section.tsx:23-35`), so the 335 imported listings
never show FAQs twice. The manifest removes those blocks; the net is then a no-op.

## 4. Crons that start in production (`apps/web/wrangler.jsonc:100-102`)

| Cron | Jobs (`apps/web/lib/worker/scheduled.ts:176-181`) | With flags as shipped |
|---|---|---|
| `0 * * * *` | draft reminders and expiry; badge program | Drafts: always on (no drafts yet; later sends real reminder emails, free-plan copy). Badge: `{enabled:false}`, reads nothing |
| `15 3 * * 1`, `45 3 * * *` | badge program weekly cycle, daily rechecks | `{enabled:false}` |
| `*/15 * * * *` | listing media: due slots, ten per run; deletes finished submission images | Queue empty after `0007`; hosts admin logo edits and approvals into `cdn` under `best.serp.co/` |

## 5. Production prerequisites

| Item | Code requires | Status |
|---|---|---|
| `BETTER_AUTH_SECRET` | Worker secret, ≥ 32 chars, else `/api/auth/*` 503 | Owner set it on both Workers (issue #60 comment, 2026-10-05). **Owner check:** `pnpm exec wrangler secret list --env production --config apps/web/wrangler.jsonc` |
| `USESEND_API_KEY` | Worker secret, else email disabled and logged | Done per [Email](../EMAIL.md#owner-prerequisites) step 1. **Owner check:** the production key is restricted to `mail.serp.co` (only staging's is confirmed) |
| Sending domain | `noreply@mail.serp.co` | **Owner check:** EMAIL.md steps 3–4 (domain verified, DKIM and DMARC pass) are not marked done |
| Access on `/admin` | `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD` vars | Verified: best.serp.co/admin/ answers 302 to `serpcompany.cloudflareaccess.com` with the AUD in `wrangler.jsonc:90` |
| `MEDIA` → `cdn` | binding, `MEDIA_BASE_URL=https://cdn.serp.co` | In `wrangler.jsonc:112-117`; cdn.serp.co answers 404 for an absent key; code writes only `best.serp.co/` keys |
| Deploy token R2 | Workers R2 Storage → Edit; production reads `cdn-staging` | MEDIA.md says done; staging deployed with its binding. **Owner check:** the `production` environment's token is that same token |
| Upload rate | ~11,300 R2 API calls | **Owner check:** the token's API rate limit (see section 2) |

## 6. Catalog publications

| Order | Manifest | Mode | Needs upload |
|---|---|---|---|
| 1 | `2026-10-06-hijacked-domains.yaml`: unpublish 95 (32 gambling or spam, 63 parked) | base v1 `669f264f…` (rows after option A) | no |
| 2 | `2026-10-06-listing-faqs.yaml`: trim 335 descriptions | rows, whole batch | no |
| 3 | `2026-10-06-legacy-media-adult-category.yaml`: Adult on 14 listings | rows | no |
| 4–10 | `2026-10-06-legacy-media-01` … `-07.yaml`: 3,199 listings | rows | yes |

**Production** (v1) applies the committed chain as is, hijacked-domains first; the publisher
contract tests pass on the committed files (`listing-faq-move`, `catalog-media`,
`listing-domain-check`: 33 tests). **Staging** needs blocker 1 resolved. Read its state
read-only first:

```bash
pnpm exec wrangler d1 execute best-serp-co-staging --env staging --remote --json \
  --config apps/web/wrangler.jsonc --command \
  "SELECT version, checksum, manifest_id, published_at FROM publication_state"
pnpm exec wrangler d1 execute best-serp-co-staging --env staging --remote --json \
  --config apps/web/wrangler.jsonc --command \
  "SELECT (SELECT COUNT(*) FROM listing_media WHERE media_key IS NOT NULL) AS hosted_rows,
   (SELECT COUNT(*) FROM publication_runs WHERE workflow='app/admin') AS admin_publications"
```

If it still shows version 1 and `669f264f…0af5a`, the committed hijacked manifest applies. Row-level
manifests need regeneration only if staging refuses one (it writes nothing and names the listings):
media via `--current <dir> --manifest-id 2026-10-07-legacy-media`
([recovery](../MEDIA.md#recovering-a-refused-media-manifest)); FAQs via
`pnpm catalog:faqs -- manifest --skip <slug> --manifest-id 2026-10-07-listing-faqs-staging`.
Production then publishes exactly the manifests staging published.

## 7. Runbook

Agents prepare PRs and run read-only checks; the owner dispatches every workflow, staging
included ([Release guards](../RELEASE_GUARDS.md#security-boundary), MEDIA.md). Each publish
writes its Time Travel bookmark and restore command to the run summary: record it.

### a. Staging

- **S0.** Resolve blockers 1 and 3 (PRs into `staging`); wait for Deploy Staging to go green on
  the new head.
- **S1.** Upload Listing Media (staging):
  `gh workflow run upload-media-staging.yml --ref staging -f plan_path=d1/media/2026-10-06-legacy-media.json -f confirmation=upload-media-best.serp.co-staging`.
  Require `failed: []` in the summary; rerun to finish 429s or timeouts.
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
- **P4.** Immediately after P2, no `/admin` writes first: Publish D1 Catalog, hijacked-domains,
  `gh workflow run publish-d1.yml --ref main -f manifest_path=d1/publications/2026-10-06-hijacked-domains.yaml -f confirmation=publish-best.serp.co-production`.
- **P5.** Same workflow for listing FAQs, then Adult category; after P3 shows `failed: []`, media
  parts 01–07.
- **P6.** Accept: `pnpm db:migrations:list:production` (none pending);
  `pnpm tsx scripts/d1-preview-http-gates.ts public https://best.serp.co`; the S3 checks with
  `PLAYWRIGHT_BASE_URL=https://best.serp.co`; `/admin/` 302 to Access; `/login/` 200 and a
  sign-in code reaches an inbox (DKIM and DMARC pass). Then unfreeze `/admin`.

### d. Rollback

| Step | Rollback (owner) |
|---|---|
| S1, P3 upload | Nothing to undo: objects are unreferenced until a manifest names them |
| S2, P4, P5 publish | Fix forward in `/admin` (Republish) or `wrangler d1 time-travel restore <db> --env <env> --config apps/web/wrangler.jsonc --bookmark <run bookmark>` ([restore](../D1_RECOVERY.md#restore)); a restore loses every later write |
| P2 deploy | Worker first: `pnpm exec wrangler rollback 59ce19ef-d561-4e0f-b654-52bbb55e5e12 --env production --config apps/web/wrangler.jsonc`, then D1 to the deploy run's first-attempt bookmark, and do not re-release `main` until a fix is promoted ([bad migration](../D1_RECOVERY.md#undo-a-bad-migration)) |

The old Worker reads `listing_media.url`, so after media publishes it hotlinks the recorded
sources as today; it shows unpublished listings as 404 instead of 410, and after the FAQ trim it
shows no FAQs (it has no FAQ section).

### e. Who does what

- **Owner only:** every dispatch above (staging and production), the typed confirmations
  `upload-media-best.serp.co-staging`, `publish-best.serp.co-staging`,
  `upload-media-best.serp.co-production`, `publish-best.serp.co-production`, and
  `deploy-best.serp.co-production` (dispatch only), the `production` approvals, the promotion
  merge, any restore or rollback, and the owner checks in section 5.
- **Agents, with the owner's go-ahead:** the blocker PRs (option A, the media refresh), read-only
  queries and dry runs, the S3 and P6 acceptance checks, and the post-publish cleanup PR
  (delete `apps/web/public/listing-logos/serpdownloaders.com/` and `media/products/launchbuzz.io/`,
  MEDIA.md "Legacy migration").
