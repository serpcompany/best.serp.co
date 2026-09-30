# Shared catalog data-operations benchmark

Status: local source evidence  
Recorded: 2026-07-30  
Command: `pnpm --filter @serpdirectory/data-ops benchmark`

This benchmark compares frozen legacy hotspot query shapes with the shared
`packages/data-ops/` implementation on a deterministic two-site SQLite fixture. It
uses SQLite statement scan status as a safe local surrogate for D1 rows scanned.
These values are not Cloudflare billing data and do not claim post-deployment
production results.

The fixture contains two isolated sites, 320 eligible listings per site, three
categories, ordering ties, multi-category memberships, logos and other media,
resources, FAQs, redirects, and ineligible rows. The optimized operations always
receive an explicit site identity.

| Operation | Legacy scan rows | Shared scan rows | Local change |
| --- | ---: | ---: | ---: |
| Previous and next navigation | 1,281 | 4 | -99.7% |
| Related listings | 1,279 | 36 | -97.2% |
| Related listings, single-category index path | 1,279 | 38 | -97.0% |
| Shell counts, cold | n/a | 1,455 | n/a |
| Shell counts, warm | n/a | 0 | n/a |
| Shell counts, one cold plus 99 warm average | n/a | 14.55 | n/a |

Navigation uses bounded index seeks instead of materializing a full eligible-catalog
window. Related selection seeks the partial `listings_related_name_idx` in ranking
order and uses indexed membership existence checks, stopping after four matches at
each score. This applies to both single- and multi-category listings without a
temporary grouping tree. The catalog data cache reads the indexed publication
version on each request; warm published-summary, detail, and shell hits avoid their
stable query work.
Migration `0009_related_listing_name_index.sql` adds this one evidence-backed index;
it was later applied to both production databases through their protected
database-and-Worker workflows.

A local OpenNext/Miniflare route using 339 eligible SERP listings independently
reported genuine D1 metadata of 10 rows read for the single-category related query
plus four logo-index rows. Before the partial index, the same local operation
reported 1,015 rows read.

After the first preview deployment, live Cloudflare D1 metadata exposed a remaining
multi-category grouping path: it read 1,040 rows before hydration. A read-only
replacement query against the actual PVD preview database returned the identical
four ranked slugs in 25 rows and used `listings_related_name_idx` with no temporary
grouping tree. The shared implementation now uses that shape.

## Production follow-up recorded 2026-07-31

The protected PVD production workflow
[`30560826641`](https://github.com/serpcompany/directory-platform-d1/actions/runs/30560826641)
retained backup artifact `8766845035` through 2026-08-29, applied
`0009_related_listing_name_index.sql`, found the deterministic import checksum already
matched, verified the 286-listing catalog, and deployed the optimized Worker.

The protected SERP production workflow
[`30561183257`](https://github.com/serpcompany/directory-platform-d1/actions/runs/30561183257)
retained backup artifact `8766961810` through 2026-08-29, applied the same migration,
found the deterministic import checksum already matched, verified the 339-listing
catalog, and deployed the optimized Worker. Cloudflare attributed 680 rows written to
SERP's one-time `CREATE INDEX` operation; that was migration/index maintenance, not
ongoing application traffic.

Read-only production checks confirmed the partial index existed in both databases,
representative related seeks read 25 rows on PVD and 30 on SERP, and live home,
category, and detail routes returned HTTP 200 with the expected titles and ordering.
In the controlled UTC window from 2026-07-30 16:26:25 through 16:27:00, nine warm
requests per site produced only nine one-row publication-version queries per database
and zero writes. No stable summary/detail hydration, aggregate, related, media, or
navigation query shape appeared in that bounded sample.

The fuller historical execution record remains available at the annotated
[`exec-plans-archive-2026-08-13`](https://github.com/serpcompany/directory-platform-d1/tree/exec-plans-archive-2026-08-13)
tag; the evidence above is retained here because it remains part of the stable
benchmark interpretation.

The representative cold detail operation executes six D1 statements and the benchmark
finishes in under 0.4 seconds locally. Summary/card contracts assert that they do not
hydrate detail content, resource links, FAQs, or non-logo media.

The production baselines that motivated this work were approximately 2,004 rows
scanned per navigation execution, 2,293 per related-listing execution, and 1,565 per
active-category-count execution. The production follow-up above records genuine D1
`rows_read` and route-level D1 call counts; the table remains a local surrogate.
