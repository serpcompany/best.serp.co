# Taxonomy migration

#341 replaces the 138 narrow categories with three layers: 16 broad hub categories, 125 tags, and 30
`/best/<keyword>/` pages, with a permanent redirect for every old category URL. This is how the
catalog's data moves, through reviewed files (#349). The operations are in
[Catalog publication](./catalog-publication.md#taxonomy-operations), and the design is in #341's
"Design (1/3)" to "(3/3)" comments.

- **Mapping.** `d1/hygiene/2026-10-10-taxonomy.yaml`: the hubs, the tags under them with the
  categories each one merges, the best pages (keyword and Ahrefs volume, intro, pins with the
  evidence that ranked them, exclusions), the redirects, and the clustered Other listings held for an
  owner flag. Its header records each decision and the rules behind the pins. It declares the
  listings each hub and tag ends with, and the generator refuses a plan that differs.
- **Catalog.** The reviewed catalog, as committed files: `2026-10-10-other-inventory.json` (#333) and
  `2026-10-10-taxonomy-inventory.json`, every other approved listing, live or unpublished, rebuilt
  the same way by the one-off script posted on #349. The generator applies on top every committed
  manifest published after that snapshot (#332, #333, #338, #340), and refuses one it can't replay.
  No D1 is read.
- **Who moves.** Every approved listing filed under a narrow category goes under its hub alone, with
  its categories' tags. A live Other listing with a #333 cluster goes to the cluster tag's hub. Left
  out: listings under a retired category, the listings #337, #358, and `other-removals` retire (two
  of #337's, slug redirect sources filed under narrow categories, are re-filed without tags, or their
  categories could never retire), and the held listings. The rest of Other stays there until #351.
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

Publish them in file order, all phases in one sitting, staging first, then production after a
promotion that holds #341's routes (#346 to #348). Before each environment, empty the review queue:
`listing-categories-set` refuses a listing whose own submission is in review, and the batch with it.
A phase-1 page renders over its redirect while it has listings, so each old URL turns into a 308 the
moment its last listing moves. `-03-retire` refuses whole until every `-02` batch is published.

