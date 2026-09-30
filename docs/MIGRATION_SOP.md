# JSON-directory to D1 migration SOP

Status: approved reusable process; no additional site migration is authorized or in progress

Responsible area: platform and catalog data  
Last verified: 2026-07-30  
Validation: `pnpm docs:check` and `pnpm migration:preflight`

This procedure describes how a maintainer can migrate one legacy site from an
external `json-directory` checkout into this multisite D1 architecture while
preserving its public behavior. It incorporates the completed `serp.software` and
`pornvideodownloaders.com` cutovers without turning legacy files into a supported
runtime source.

This document prepares future work. Do not import another site merely because this
SOP exists.

## Scope and support boundary

The current repository deploys two explicitly registered tenants:
`serp.software` and `pornvideodownloaders.com`. Each has a distinct app, Worker,
local state, production D1 database, protected production environment, initial
artifact, parity report, and browser coverage. Both Sites have one isolated active
replacement Preview D1, Preview Worker, and protected environment. Their temporary
Issue #72 source Preview databases were deleted after the completed cutover.
Shared publication, submission, and release tools require an explicit site ID from
`scripts/site-targets.ts`.

That working two-site baseline is reusable, but it is not an automatic site factory.
Every additional migration must extend and prove all of these boundaries:

- `apps/<site-id>/` and its server-only catalog/submission repositories;
- `sites/<site-id>/site-config.ts` and presentation assets;
- the exhaustive active-site registry and explicit command aliases;
- site-specific initial import artifacts and parity report;
- isolated local, preview, and production Wrangler/D1 identities;
- protected deploy, publish, submission, notification, and backup behavior;
- runtime, route, search, sitemap, RSS, redirect, and browser evidence.

Never add only a `sites/` directory or only a `sites` table row. The relational
`site_id` column does not by itself prove runtime or release isolation.

Legacy catalog files must remain in the external source checkout. They may be read by
the migration harness during a reviewed migration, but they must never be copied into
this repository, committed, served, or retained as a fallback.

## Required evidence package

Publish a governing GitHub spec and independently verifiable vertical-slice tickets
with explicit blocking relationships. If the route to a safe migration is still
unclear, use a `wayfinder` map and decision tickets before publishing the spec.

Keep temporary evidence under the ignored directory:

```text
tmp/migrations/<site-id>/
  preflight.json
  source-inventory.md
  field-map.md
  normalization-report.json
  parity-report.yaml
  route-samples.txt
  asset-inventory.json
  rollback-plan.md
```

The committed migration result may include:

- new or generalized application configuration;
- forward-only D1 migrations;
- deterministic initial SQL and bounded import batches;
- a committed parity report with source hashes, counts, and exact slug sets;
- tests for mapping, configuration, runtime, routes, and release workflows;
- documentation and closed GitHub issues containing the acceptance evidence.

Do not commit the source catalog, normalized catalog JSON, database exports containing
production data, secrets, or Wrangler credentials.

Every evidence item must identify the source Git commit and source file SHA-256
checksums. A count without a source identity is not reproducible evidence.

## Phase 0: choose the tenancy architecture

Record one tenancy decision on the governing spec or decision-map issue before
writing migration code.

### Option A: independent deployment repository

Use the D1 platform as a baseline for a separate site repository. This offers the
clearest Worker, database, workflow, and rollback isolation. Adapt all site identity
and branding deliberately; do not preserve `serp.software` literals accidentally.

### Option B: multiple sites in this monorepo

Add a distinct app/Worker boundary and, by default, a distinct D1 database for each
site. Shared packages may remain common, while binding identities, local state,
protected environments, backups, and deployments remain isolated.

A shared physical D1 database is a separate architecture decision. The schema’s
tenant columns are necessary but insufficient proof of safe shared tenancy. It
requires tenant-bound queries, tenant-bound uniqueness, authorization analysis,
backup/restore impact analysis, and cross-tenant tests.

### Required platform extension for Option B

The platform already satisfies this contract for its two active Sites. A new Site's
governing spec and tickets must extend it without weakening any item:

1. add the site to the exhaustive registry and every required workflow choice or
   matrix;
2. make site configuration selection explicit and exhaustive—never default/fallback;
3. parameterize local, preview, and production Worker/D1 identities;
4. preserve one protected production environment and confirmation phrase per site;
5. register site-specific bootstrap artifacts and parity reports without weakening
   checks;
6. make publisher schemas bind a reviewed site ID rather than accepting arbitrary
   caller input;
7. test that every query, redirect, publication, and verification is tenant-bound;
8. prove builds and local D1 states do not cross between apps or worktrees;
9. document whether assets are copied, referenced, or moved to R2;
10. prove one site can fail, roll back, or deploy without mutating another.

Do not solve these by adding a default site, wildcard configuration, filesystem
fallback, or generic JSON source adapter.

## Phase 1: freeze and inventory the source

1. Identify the authoritative legacy repository and site directory.
2. Record its remote, branch, and exact commit.
3. Stop catalog edits or define a cutoff commit and delta policy.
4. Confirm the source checkout is clean.
5. Inventory site configuration, content, assets, redirects, deployment behavior,
   analytics, forms, SEO routes, RSS, sitemap, and catalog files.
6. Run the read-only preflight from this repository:

```bash
mkdir -p tmp/migrations/example.com
pnpm migration:preflight -- \
  --source-root /Users/devin/dev/repos/json-directory \
  --site-id example.com \
  --output tmp/migrations/example.com/preflight.json
```

The preflight verifies:

- the external site directory and expected source files exist;
- product records are keyed by valid, matching slugs;
- titles, taglines, URLs, and category memberships are structurally usable;
- category slugs are unique;
- every listing membership resolves to a declared category;
- repeatable fields have the expected container shape;
- supporting config, content, assets, and README files are inventoried;
- source checksums and record counts are captured.

`readyForMapping: true` means only that the source is coherent enough to map. It is
not authorization to modify D1 and is not proof of application parity.

Resolve every issue or record an explicit, reviewed normalization decision. Warnings
may be accepted only through a decision recorded on the governing GitHub issue.

## Phase 2: map and normalize

Create a field map before generating SQL. Preserve facts; do not silently invent
content.

| Legacy concept | D1 target | Mapping rule |
|---|---|---|
| site identity | `sites.id` and runtime site config | Exact reviewed site ID. |
| category slug/name/description | `categories` | Preserve slug; assign deterministic sort order from source order. |
| product map key | `listings.slug` | Must equal the nested declared slug. |
| title | `listings.name` | Preserve Unicode text after boundary parsing. |
| tagline | `listings.description` | Preserve as public summary. |
| product page URL | `listings.website` | Parse as HTTP(S); record intentional URL changes. |
| content body | `listings.content` | Preserve Markdown; compare rendered semantics. |
| category list | `listing_categories` | Preserve order; first membership is primary unless source semantics say otherwise. |
| featured flag | `listings.is_featured` | Parse a real boolean; missing means false. |
| media logo/images/video | `listing_media` | Preserve kind and order; decide asset ownership separately. |
| related links | `listing_resource_links` | Parse label and HTTP(S) URL; preserve order. |
| FAQ entries | `listing_faqs` | Preserve question, answer, and order. |
| source ordering | display/sort columns | Preserve intentionally and test it. |
| publication state | status and `published_at` | Use a documented cutoff timestamp; do not backdate casually. |

### Stable identifiers

Generate listing IDs deterministically from the reviewed site ID and source identity,
or preserve an already stable identifier. Record the algorithm and collision check.
IDs must not depend only on a mutable slug if slug redirects or later renames are
required.

### Normalization report

Report every transformation, including:

- trimmed or normalized strings;
- invalid or rewritten URLs;
- duplicate or renamed slugs;
- category aliases and missing memberships;
- unsupported legacy fields;
- Markdown or HTML conversions;
- asset URL changes;
- records excluded from publication and why.

The report must show zero unexplained drops. A record may be intentionally excluded
only through a reviewed decision with its source identity.

### Parse, then transform

The migration tool should parse the legacy shape into precise source types, then map
those types into D1 rows. Domain transformation code must not repeatedly accept
`unknown` or loosely shaped objects. Invalid input stops artifact generation.

## Phase 3: construct deterministic D1 artifacts

Only begin after the Phase 0 extension design and source/field map are approved.

1. Add any required forward-only schema migration.
2. Extend the external-only source adapter, active-site registry, and reusable
   `scripts/migration/generate-initial-artifact.ts` boundary for the reviewed legacy
   shape. Do not add a runtime adapter.
3. Generate deterministic SQL and bounded import batches directly into a site-specific
   artifact directory.
4. Emit a parity report containing source commit, source hashes, mapping version,
   listing/category counts, exact slug set, row-level checksums, batch count, and
   target publication checksum.
5. Run the generator twice from the same source commit and compare byte-for-byte
   outputs.
6. Commit generated SQL and parity evidence, not an intermediate catalog file.
7. Keep the generator external-only and tested. Isolate every source- or site-specific
   normalization rule, preserve it when reproducibility requires it, and document its
   evidence instead of turning it into runtime behavior.

Run the generator only after the new site is registered:

```bash
pnpm migration:generate -- \
  --source-root /absolute/path/to/json-directory \
  --site-id example.com
```

The artifact must be idempotent at the release boundary. The importer may initialize
an empty publication state or no-op on the exact checksum. It must refuse to overwrite
a different publication.

Use small batches that fit D1 limits. Preserve foreign-key ordering:

1. site;
2. categories;
3. listings;
4. category memberships;
5. media, resources, and FAQs;
6. publication state and audit evidence.

## Phase 4: prove local parity

Use an isolated worktree and local D1 state. Create the worktree from its controlling
checkout:

```bash
pnpm worktree:new -- example-com-migration
cd ../directory-platform-d1-worktrees/example-com-migration
pnpm worktree:doctor
pnpm tsx scripts/d1-local-guard.ts migrate --site example.com
pnpm tsx scripts/d1-local-guard.ts import --site example.com
pnpm tsx scripts/d1-local-guard.ts verify --site example.com
```

The registry and local guard must recognize the new site before these commands run.
Root aliases are conveniences for existing sites, not a default-tenant mechanism.

Parity proof must cover:

- exact approved listing count and slug set;
- exact active category count and slug set;
- duplicate IDs, slugs, and memberships;
- exactly one primary active category per public listing;
- repeatable field counts and ordering;
- publication version and checksum;
- source-to-target row checksums or reviewed semantic comparisons;
- home page ordering and pagination;
- product and category routes;
- search terms, result URLs, and empty states;
- RSS and sitemap membership;
- legacy redirects and canonical URLs;
- site configuration, branding, navigation, analytics, and submission behavior;
- representative desktop and mobile browser journeys;
- viewport containment for mobile hero, navigation, cards, forms, and long labels
  using element bounding boxes—not only `document.scrollWidth`;
- missing D1 binding and wrong-environment fail-closed behavior.

Run:

```bash
pnpm harness:fast
pnpm test:e2e:smoke
pnpm harness:check
```

Attach actual command output and browser artifacts to the governing ticket. A
successful build does not prove data or route parity.

## Phase 5: provision Cloudflare safely

Provisioning requires explicit Cloudflare and repository authority.

1. Create site-specific preview and production D1 databases.
2. Record real IDs only in the intended Wrangler configuration; never in templates or
   public docs.
3. Create a site-specific Worker name, route/domain, and protected GitHub environment.
4. Configure scoped Cloudflare credentials as environment secrets. Verify the
   authenticated principal can read the intended account and only the required
   Worker/D1 resources before the first mutation.
5. Add exact confirmation phrases for preview/production mutations.
6. Validate that local config contains only the synthetic local D1 ID.
7. Add remote plan commands that reveal target names/IDs without mutating them.
8. Require a retained D1 backup before migration or import.
9. Ensure remote workflows run only from the intended branch and clean commit.

Never copy `serp.software` production IDs to another site. Never use a local Wrangler
command as a substitute for the protected workflow.

Cloudflare displays the account identifier and API token in nearby UI/API contexts.
Treat them as distinct values: confirm the account ID against the authenticated
account endpoint, then verify the token with a read-only request. Do not infer either
value from its label, length, clipboard order, or a successful login. Record only
redacted identity evidence on the governing ticket.

## Phase 6: rehearse and release

### Preview rehearsal

1. use a newly provisioned, empty preview database or retain a backup if preview
   already contains meaningful data;
2. apply migrations;
3. import only into empty expected publication state;
4. run exact remote parity verification;
5. deploy the preview Worker;
6. execute the route and browser checklist, including real mobile screenshots and
   element-containment assertions;
7. run the same protected preview release a second time against the populated
   database and prove the identical publication checksum produces an import no-op;
8. rehearse restoration or document the tested recovery mechanism.

### Production release

1. merge the reviewed code, artifacts, tests, and workflows associated with the
   governing migration tickets;
2. record the exact commit to release;
3. stop legacy catalog writes at the cutoff;
4. retain a production D1 backup;
5. apply forward migrations;
6. import the deterministic artifact;
7. verify checksum, counts, exact slugs, memberships, and publication state;
8. deploy the Worker only after D1 verification passes;
9. verify home, representative products/categories, search, RSS, sitemaps, canonical
   URLs, and redirects over the public domain;
10. monitor errors and preserve the legacy deployment during the agreed observation
    window.
11. record the final workflow runs, public evidence, and exact deployed commit.

Every step must be visible in a protected workflow. A database verification failure
must stop Worker deployment.

## Phase 7: remove the JSON architecture

After production parity and the observation window:

1. remove catalog files from the new project;
2. remove JSON loaders, adapters, generators, schemas used only by the old runtime,
   browser search indexes, static builds, and Pages deployment paths;
3. remove starter/default site fallbacks and obsolete workflows;
4. make taxonomy, search, RSS, sitemap, submission options, and redirects D1-derived;
5. add architecture-guard cases for every removed source kind and filename;
6. update `AGENTS.md`, architecture, data model, development, build, deploy, and
   onboarding docs;
7. search tracked and generated outputs for legacy catalog filenames;
8. rebuild and repeat the search;
9. archive the legacy repository as read-only or clearly mark it superseded;
10. post final acceptance evidence and residual risks, then close the implementation
    tickets and governing spec;
11. from the controlling checkout, remove the registered migration worktree with
    `pnpm worktree:destroy -- <name>`; after merge and recovery review, delete the
    merged migration branch if it is no longer needed.

Deletion is not parity proof. Remove the old path only after D1 and public runtime
evidence are independently established. Git history remains the recovery path for
removed repository files.

## Rollback and recovery

Define rollback before production mutation.

- Retain the pre-change D1 export for the required recovery window.
- Keep the legacy deployment available until acceptance and observation complete.
- If import verification fails before traffic cutover, stop; do not deploy the new
  Worker.
- If the Worker fails but D1 verification passed, roll back the Worker version rather
  than automatically overwriting valid D1 state.
- If D1 data is wrong, stop publication, review the retained export and target
  recovery point, obtain fresh production approval, restore through the reviewed
  Cloudflare procedure, and re-run exact verification.
- Never “roll back” with a source catalog import after ongoing D1 publications have
  begun; that can erase legitimate changes.
- Record every partial failure and retry on the governing ticket.

All migration and import steps must be idempotent or explicitly state why they are not
and how to recover safely.

## Completion checklist

### Architecture

- [ ] Tenancy/deployment option is decided and implemented.
- [ ] All site identity, Worker, D1, workflow, and artifact boundaries are explicit.
- [ ] Runtime catalog reads are D1-only and fail closed.
- [ ] No default site, catalog fallback, or generic JSON runtime exists.

### Source and mapping

- [ ] Source repository, commit, cutoff, and SHA-256 checksums are recorded.
- [ ] Preflight issues are zero; accepted warnings are documented.
- [ ] Field map and normalization report explain every transformation and exclusion.
- [ ] Stable ID and ordering rules are deterministic.

### Data evidence

- [ ] Fresh local migrations succeed.
- [ ] Initial import is deterministic and safely retryable.
- [ ] Listing/category counts and exact slug sets match.
- [ ] Memberships, primary categories, repeatables, and row checksums match.
- [ ] Publication version/checksum and audit evidence match.

### Application evidence

- [ ] Home, product, category, search, RSS, sitemap, canonical, and redirect behavior
      match the approved source behavior.
- [ ] Site config, content, assets, analytics, and submission flows are accounted for.
- [ ] Browser evidence covers representative desktop and mobile journeys.
- [ ] Missing/wrong bindings fail closed.

### Release and recovery

- [ ] Preview rehearsal and recovery procedure succeeded.
- [ ] A second populated preview release proved checksum-idempotent import behavior.
- [ ] Protected production backup, migration, import, verify, and deploy steps exist.
- [ ] Post-release checks passed on the public domain.
- [ ] Mobile screenshots and element-containment assertions show no viewport escape.
- [ ] Rollback decision points and retained artifacts are recorded.

### Cleanup and knowledge

- [ ] Catalog files and obsolete runtime/deployment code are absent.
- [ ] Architecture guards prevent regression.
- [ ] Docs, skills, and closed GitHub issue set reflect the final system.
- [ ] `pnpm harness:check` and relevant runtime checks pass from the release commit.
- [ ] The merged migration worktree and unneeded branch were cleaned safely.
