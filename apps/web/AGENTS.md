# `apps/web` application rules

This application is the best.serp.co Cloudflare Worker, not a filesystem-backed site.

- Keep D1 binding acquisition and runtime validation in `lib/catalog/repository.ts`
  and `lib/submissions/repository.ts`; keep catalog SQL and DTOs in
  `packages/data-ops/`.
- Client Components may consume serialized results or `/api/search`; they may not
  import D1 bindings, repositories, or Wrangler configuration.
- New public routes must preserve D1 eligibility rules and appear in sitemap behavior
  where appropriate. Existing public URLs are an SEO contract: add permanent
  redirects to `lib/routing/redirects.ts` (applied by `next.config.ts`) when moving one,
  with a canonical destination.
- Write page URLs with a trailing slash and file URLs without one; build absolute URLs
  with `siteUrl` / `absoluteUrl` so the homepage is the bare origin. The Worker entry
  redirects everything else (see the URL canonicalization section of the architecture doc).
- Site identity, copy, and route layout come from `packages/site-config`; do not add
  environment-based site selection.
- Validate Worker compatibility with `pnpm worker:build`.

See [Architecture](../../docs/ARCHITECTURE.md) and [Harness](../../docs/HARNESS.md).
