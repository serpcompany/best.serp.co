# Directory Platform on Cloudflare D1

This repository contains the production `serp.software` and
`pornvideodownloaders.com` applications. Each is a distinct Next.js OpenNext Worker
whose directory catalog is stored in its own Cloudflare D1 database.

There is one catalog authority:

- runtime listings, categories, search, RSS, and sitemaps read from the `DB` binding;
- the shared schema lives in `packages/data-ops/src/schema.ts` and fresh replacement
  database migrations live in `d1/drizzle/`; released `d1/migrations/0001`-`0009`
  remain immutable legacy history;
- reviewed catalog mutations live in `d1/publications/`;
- the initial SQL bootstrap and its parity evidence live in `d1/artifacts/`.

Catalog JSON files, static search indexes, JSON import adapters, starter wrappers, and
static-directory deployment code are intentionally absent. `pnpm test:repo` enforces
that boundary.

## Local preview

Use Node 24 and pnpm:

```bash
pnpm install
pnpm d1:local:migrate
pnpm d1:local:import
pnpm d1:local:verify
pnpm dev
```

These aliases select `serp.software`. Use the
`d1:pornvideodownloaders:local:*`, `preview:pornvideodownloaders`, and
`agent:pornvideodownloaders:*` commands for the second site.

The guarded preview builds the OpenNext Worker and runs it with a local D1 database.
It cannot target preview or production Cloudflare resources.

## Verification

```bash
pnpm worker:config:validate
pnpm test:d1
pnpm test:repo
pnpm typecheck
pnpm worker:build
```

Production releases run only from protected GitHub Actions workflows on `main`.

For agent-first development, use `pnpm harness:fast` during implementation and
`pnpm harness:check` before handoff. `pnpm agent:manifest` exposes the current local
runtime and binding identity.

See the [documentation index](./docs/README.md), [Harness](./docs/HARNESS.md), and
[Migration SOP](./docs/MIGRATION_SOP.md).
