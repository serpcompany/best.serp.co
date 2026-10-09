# `apps/web` application rules

This application is the best.serp.co Cloudflare Worker, not a filesystem-backed site.

- Keep D1 binding acquisition and runtime validation in `src/lib/catalog/repository.ts`,
  `src/lib/submissions/repository.ts`, `src/lib/email/runtime.ts`, `src/lib/auth/server.ts`,
  and (with the `MEDIA` R2 binding) `src/lib/media/worker-media.ts`; keep catalog, account,
  email, and media SQL and DTOs in `apps/web/src/db/`.
- Listing images are hosted, never hotlinked: render media URLs the catalog adapter resolved on
  `MEDIA_BASE_URL`, and send new images through `src/lib/media/server.ts` (#95).
- Every page and route under `src/app/(dashboard)/admin/` and `src/app/api/admin/` calls `requireAdmin()` or
  `authorizeAdminRequest()` (`src/lib/auth/server.ts`); the architecture guard enforces it.
- Client Components may consume serialized results or `/api/search`; they may not
  import D1 bindings, repositories, or Wrangler configuration.
- New public routes must preserve D1 eligibility rules and appear in sitemap behavior
  where appropriate. Existing public URLs are an SEO contract: add permanent
  redirects to `src/lib/routing/redirects.ts` (applied by `next.config.ts`) when moving one,
  with a canonical destination.
- Write page URLs with a trailing slash and file URLs without one; build absolute URLs
  with `siteUrl` / `absoluteUrl` so the homepage is the bare origin. The Worker entry
  redirects everything else (see [URLs](../../docs/URLS.md)).
- Site identity, copy, and route layout come from `src/lib/site`; do not add
  environment-based site selection.
- Imports flow one way: `src/lib` and `src/db` never import components or routes, and components
  never import routes (`noRestrictedImports` in `biome.jsonc`; tests are exempt).
- Validate Worker compatibility with `pnpm build`.

See [Architecture](../../docs/ARCHITECTURE.md) and [Harness](../../docs/HARNESS.md).
