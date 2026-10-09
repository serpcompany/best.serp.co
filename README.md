# best.serp.co

Source for [best.serp.co](https://best.serp.co), SERP's software and AI tools
directory. It is a Next.js app deployed as a Cloudflare Worker (OpenNext) with its
catalog in Cloudflare D1.

- Runtime listings, categories, search, RSS, and sitemaps read from the `DB` binding.
- The schema lives in `apps/web/src/db/schema.ts`; migrations live in `apps/web/drizzle/`.
- Reviewed catalog changes live in `d1/publications/`; public submissions are staged
  in D1 and approved by a maintainer (see [Submission flow](./docs/SUBMISSION_FLOW.md)).

The catalog was imported once from the JSON `serp.co` site in
`serpcompany/json-directory-template@25e2a8d` (serpcompany/best.serp.co#34). D1 is now
the source of truth.

## Local development

Use Node 24 and pnpm. Local D1 is seeded with fixtures (fake listings, users, and
submissions), never real data:

```bash
pnpm install
pnpm db:seed:local
pnpm preview
```

`pnpm preview` builds the Worker and serves it on http://localhost:8787 against the local
D1 database. It cannot reach staging or production resources. See
[Development](./docs/DEVELOPMENT.md#local-data) for what the seed holds.

## Verification

```bash
pnpm harness:fast
pnpm test:e2e
```

Pull requests target `staging`, which deploys the staging Worker. `main` is production: the
owner promotes `staging` to `main` by fast-forward (`pnpm release:promote`), and protected
GitHub Actions workflows release it. See [Release guards](./docs/RELEASE_GUARDS.md#promotion), the
[deploy runbook](./docs/DEPLOY_RUNBOOK.md), and the [docs index](./docs/README.md).
