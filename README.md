# best.serp.co

Source for [best.serp.co](https://best.serp.co), SERP's software and AI tools
directory. It is a Next.js app deployed as a Cloudflare Worker (OpenNext) with its
catalog in Cloudflare D1.

- Runtime listings, categories, search, RSS, and sitemaps read from the `DB` binding.
- The schema lives in `packages/data-ops/src/schema.ts`; migrations live in `d1/drizzle/`.
- Reviewed catalog changes live in `d1/publications/`; public submissions are staged
  in D1 and approved by a maintainer (see [Submission flow](./docs/SUBMISSION_FLOW.md)).

The catalog was imported once from the JSON `serp.co` site in
`serpcompany/json-directory-template@25e2a8d` (serpcompany/best.serp.co#34). D1 is now
the source of truth.

## Local development

Use Node 24 and pnpm. The import artifacts are generated from a local checkout of
`serpcompany/json-directory-template` at the pinned commit:

```bash
pnpm install
pnpm migration:generate -- --source-root ../json-directory --site-id serp.co
pnpm d1:local:migrate
pnpm d1:local:import
pnpm d1:local:verify
pnpm dev
```

`pnpm dev` builds the Worker and serves it on http://localhost:8787 against the local
D1 database. It cannot reach staging or production resources.

## Verification

```bash
pnpm harness:fast
pnpm test:e2e
pnpm migration:compare -- http://localhost:8787
```

Production releases run only from protected GitHub Actions workflows on `main`; see
the [deploy runbook](./docs/DEPLOY_RUNBOOK.md) and the [docs index](./docs/README.md).
