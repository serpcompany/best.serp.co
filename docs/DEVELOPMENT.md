# Development

Install dependencies with Node 24 (`.nvmrc`) and `pnpm install`.

## Local catalog

Local D1 is seeded from the one-time import artifacts, which are generated (not
committed) from a checkout of `serpcompany/json-directory-template` at `25e2a8d`:

```bash
git clone https://github.com/serpcompany/json-directory-template ../json-directory
git -C ../json-directory checkout 25e2a8d
pnpm migration:generate -- --source-root ../json-directory --site-id serp.co
```

The generator is deterministic and must reproduce the committed
`d1/artifacts/best-serp-co-v1-parity.yaml` target checksum. Then prepare the local
database:

```bash
pnpm d1:local:migrate
pnpm d1:local:import
pnpm d1:local:verify
```

State lives under `.wrangler/drizzle-state/best-serp-co/` and uses the synthetic
local database in `apps/web/wrangler.jsonc`. Repeating `migrate` or `import` after a
successful import is a no-op.

## Run the Worker

```bash
pnpm dev
```

This builds the OpenNext Worker and serves it on http://localhost:8787 against local
D1. `pnpm --filter web dev` runs `next dev` for UI work, but only the Worker preview
exercises the real D1 binding.

## Schema changes

Edit `packages/data-ops/src/schema.ts`, then generate a migration:

```bash
pnpm d1:generate
```

Review the SQL and keep the D1 specifics described in [Data model](./DATA_MODEL.md)
(`STRICT` tables and triggers). Never use `drizzle-kit push`.

## Parity against the live site

```bash
pnpm migration:compare -- http://localhost:8787 --sample 60
```

This compares status, title, h1, canonical path, meta description, JSON-LD types, and
FAQ count for sampled pages between https://best.serp.co and the candidate origin.

## Validation

```bash
pnpm harness:fast
pnpm test:e2e
```
