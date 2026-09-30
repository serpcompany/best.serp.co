# serp.software

`serp.software` is one of two active deployable directories in this repository. Its
public listing and category data is read at request time from the `DB` Cloudflare D1
binding. Public product detail pages remain under `/products/[slug]/`.

SERP has separate local, protected Preview, and Production identities. Its active
replacement Preview D1, Worker, and protected environment were rehearsed by Issue
#72; the temporary source Preview D1 was later deleted with retained evidence. The
local `worker:preview` command remains local-only and is not the remote Preview target.

## Data ownership

- Canonical runtime data: Cloudflare D1.
- Schema changes: reviewed Drizzle history under `d1/drizzle/`.
- Badge-verified intake: normalized private D1 submission tables with assigned
  private GitHub review notifications.
- Approved mutations: versioned YAML manifests under `d1/publications/`.
- Initial bootstrap evidence: immutable SQL and parity files under `d1/artifacts/`.

Catalog JSON files are intentionally absent and are rejected by the repository guard.

## Local development

Database commands require explicit authorization. Once authorized, the guarded local
flow is:

```bash
pnpm d1:local:migrate
pnpm d1:local:import
pnpm d1:local:verify
pnpm worker:preview
```

Non-database validation is always safe:

```bash
pnpm test:d1
pnpm worker:config:validate
pnpm worker:build
```

Production schema/import/deploy operations and publication manifests run only through
their protected, manually confirmed GitHub Actions workflows.
