# Taxonomy migration

#341 replaces the 138 narrow categories with three layers: 16 broad hub categories, 125 tags, and 30
`/best/<keyword>/` pages, with a permanent redirect for every old category URL. This is how the
catalog's data moves, through reviewed files (#349). The operations are in
[Catalog publication](./catalog-publication.md#taxonomy-operations), and the design is in #341's
"Design (1/3)" to "(3/3)" comments.

- **Mapping.** `d1/hygiene/2026-10-10-taxonomy.yaml`: the hubs, the tags under them with the
  categories each one merges, the best pages (keyword and Ahrefs volume, intro, pins with the
  evidence that ranked them, exclusions), the listings that name a feature of a larger site (never
  pinned), the redirects, and the clustered Other listings held for an owner flag. Its header records
  each decision and the rules behind the pins. It declares the listings each hub and tag ends with,
  and the generator refuses a plan that differs.
- **Catalog.** The reviewed catalog, as committed files: `2026-10-10-other-inventory.json` (#333) and
  `2026-10-10-taxonomy-inventory.json`, every other approved listing, live or unpublished, rebuilt
  the same way by the one-off script posted on #349. On top, the generator applies the 16 manifests
  published after that snapshot that it names (`taxonomyInputManifests`: #332, #333, #338, #340),
  and refuses one it can't replay. A manifest committed later is never read, so what it generates
  stays fixed once published. No D1 is read.
- **Who moves.** Every approved listing filed under a narrow category goes under its hub alone, with
  its categories' tags. A live Other listing with a #333 cluster goes to the cluster tag's hub. Left
  out: listings under a retired category, the listings #337, #358, and `other-removals` retire, and
  the held listings. A slug redirect source filed under a narrow category is re-filed without tags,
  or the category could never retire (#337's `lambdalabs.com` and `timelyapp.com`). The rest of
  Other stays there until #351.
- **Manifests.** `pnpm catalog:taxonomy` (`scripts/taxonomy-manifest.ts`) writes
  `d1/publications/2026-10-10-taxonomy-*.yaml`, each planning at most 2,000 statements, in three
  phases ([Taxonomy operations](./catalog-publication.md#taxonomy-operations)): `-01a-create` (hubs,
  tags, best pages and pins) and `-01b-redirects`; `-02-move-NN` (`listing-tags-set` and
  `listing-categories-set` per listing); and `-03-retire` (`category-unpublish` of every narrow
  category). A listing keeps its `-02` batch when they are regenerated, as #333's do.
- **Tests.** `scripts/taxonomy-manifest.test.ts` keeps the manifests identical to the mapping and
  replays every phase on the fixture and scale catalogs and on the reviewed catalog after the
  manifests it follows: each narrow category ends empty and retired, every old URL and every tag a
  tag-only best page takes over has a redirect, every published listing has one category, the counts
  are the mapping's, and no redirect or active best page ends at a retired category, tag, or page.
  It runs the checks below on the replay, as written here.

## Publishing

Publish the manifests in file order, all phases in one sitting, staging first, then production after
a promotion that holds #341's code (#346's routes, and #348's resolver for drafts that name a retired
category). The hubs, tags and redirects stay inert until listings move: a page renders over its
redirect while it has listings, so each old URL turns into a 308 the moment its last listing moves.
The best pages go live at `-01a`, though: their pins count toward their pool, so each renders its 10
entries at once, linking to tags and hubs that stay empty until phase 2. Publish `-01b` and every
`-02` batch straight after.

Before each environment, run these read-only checks and expect no rows. Each runs with
`pnpm exec wrangler d1 execute <database> --env <environment> --remote --json --config
apps/web/wrangler.jsonc --command "<check>"`, where the database is `best-serp-co-staging` with
`--env staging`, or `best-serp-co-production` with `--env production`.

1. **No submission in review.** `listing-categories-set` refuses a listing whose own submission is in
   review, and its whole batch. Resolve each one in `/admin` first:

   ```sql
   SELECT l.slug, s.status FROM listing_submissions s JOIN listings l ON l.id=s.listing_id WHERE s.status IN ('paid_pending_review','changes_requested') ORDER BY l.slug
   ```

2. **No owner revision open.** A move gives the listing a new checksum, so a revision opened before
   it could never be approved. Approve or reject each one first:

   ```sql
   SELECT l.slug, r.status FROM listing_revisions r JOIN listings l ON l.id=r.listing_id WHERE r.status IN ('pending_review','changes_requested') ORDER BY l.slug
   ```

3. **Before `-03-retire`: nothing filed under a narrow category that `category-unpublish`
   refuses**, a live listing or a slug redirect source. A listing approved since the reviewed
   catalog would show here: file it under its hub first. Unpublished listings filed under Adult as
   well stay where they are and don't count.

   ```sql
   SELECT c.slug AS category, l.slug AS listing FROM listing_categories lc JOIN categories c ON c.id=lc.category_id JOIN listings l ON l.id=lc.listing_id WHERE c.is_active=1 AND c.slug NOT IN ('writing','image-design','developer-tools','productivity','chatbots-agents','marketing','business','audio','lifestyle','education','video','data-analytics','careers','ecommerce','video-downloaders','cloud-hosting','other') AND ((l.status='approved' AND l.is_active=1) OR EXISTS (SELECT 1 FROM listing_slug_redirects r WHERE r.old_slug=l.slug)) ORDER BY c.slug, l.slug
   ```

A refused batch writes nothing. If it refused only because of the review queue or a revision, clear
that and publish the same manifest again. Regenerate only when a listing itself changed: it keeps
its batch, so only that batch's file changes.
