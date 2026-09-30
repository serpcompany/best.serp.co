# `serp.software` application rules

This application is a Cloudflare Worker, not a filesystem-backed Next.js site.

- Keep D1 binding acquisition and site validation in
  `lib/catalog/repository.ts`; keep shared catalog SQL and DTOs in
  `packages/data-ops/`.
- Add new catalog operations to the shared package so every site receives the same
  query behavior. Do not copy SQL into this application.
- Client Components may consume serialized results or `/api/search`; they may not
  import D1 bindings, repositories, or Wrangler configuration.
- New public routes must preserve D1 eligibility rules and be represented in sitemap
  behavior where appropriate.
- Use the checked-in config from `sites/serp.software/`; do not introduce defaults or
  another source-kind branch.
- Validate Worker compatibility with `pnpm worker:build`.
- Use `pnpm agent:dev` when runtime logs and isolated D1 state are needed.

See [Architecture](../../docs/ARCHITECTURE.md) and
[Harness](../../docs/HARNESS.md).
