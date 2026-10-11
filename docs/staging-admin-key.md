# Staging admin key

Agents can't type a sign-in code into `/login`, so on staging they call the admin API with a key
instead of a session (serpcompany/best.serp.co#408). The code is
`apps/web/src/lib/auth/staging-admin-key.ts`, checked by the Worker's admin gate
([Accounts](./accounts.md#admin-gate)) and again by `authorizeAdminRequest()`
([Admin panel](./admin-panel.md#requests)).

## What it allows

- **Where it works:** `/api/admin/*` on the staging Worker only (`SITE_ENVIRONMENT` and
  `D1_RUNTIME_ENV` both `staging`), on a request that gave staging's password
  ([Architecture](./architecture.md#environments-and-hosts)). Production and local refuse any key,
  even with the secret set, and the smoke-test exemption doesn't carry it. It opens no `/admin`
  page, and never creates a session or sets a cookie.
- **Never the allowlist:** the right key on `/api/admin/admins` (adding or removing an admin) is
  403 `admin_key_forbidden`, from the Worker gate, `authorizeAdminRequest()`, and the route
  itself, which refuses any request without a session. Only a person changes who is an admin.
- **The key** is the Worker secret `STAGING_ADMIN_TOKEN`, at least 32 characters once trimmed
  (without it, every key is refused), sent as `X-Staging-Admin-Token` and compared in constant
  time. A request with the header is judged by the key alone: a wrong key is 401 even with a
  session.
- **Identity:** the fixed actor `staging-agent` (no email can equal it) on every decision, event
  and `publication_runs` row. The plans' compare-and-swap guards hold as for any admin. Only a
  valid key skips the `Origin` check: no browser sends the header on its own, so it can't be
  forged cross-site. Session requests keep the check.
- **Never logged:** no log line, answer or error carries it, Sentry never receives request
  headers, and Cloudflare's tail events redact any header whose name contains `token`.

## Where it lives

The staging Worker secret (set since 2026-10-12), and one copy per machine outside the
repository, `~/.config/best.serp.co/staging-admin-token` (directory 700, file 600), which every
checkout and worktree on that machine shares. Never put the value in the repository, a log, an
issue or a pull request, and never set it on production.

## Use it

Every call names staging's password (`staging:stagingpassword`,
[Architecture](./architecture.md#environments-and-hosts)) and reads the key from that file:

```bash
curl -u staging:stagingpassword \
  -H "X-Staging-Admin-Token: $(cat ~/.config/best.serp.co/staging-admin-token)" \
  https://staging.best.serp.co/api/admin/...
```

For example, `-H 'content-type: application/json' -d '{"expectedContentVersion": 1}'` on
`…/api/admin/submissions/<id>/approve`, or a new tag on `…/api/admin/tags`. The key opens no read
screen, so take ids and `content_version` from staging D1 with a read-only query. An unknown path
such as `/api/admin/` answers 404 to a valid key and 401 to any other.

## Rotate or revoke

Agents don't change Cloudflare secrets ([Email](./email.md#owner-prerequisites)); this secret is
the one owner-authorized exception (#408), and only for the lead agent. Rotate only when:

- a new machine has no key file and needs one, or
- a leak is suspected.

Rotating sets a new secret, which deploys a new staging Worker version and breaks every other
machine's copy at once, so announce it on the open `handoff` issue (or the active lead issue)
before running it. From `apps/web`:

```bash
mkdir -p ~/.config/best.serp.co && chmod 700 ~/.config/best.serp.co
(umask 077 && openssl rand -hex 24 | tr -d '\n' > ~/.config/best.serp.co/staging-admin-token)
pnpm exec wrangler secret put STAGING_ADMIN_TOKEN --env staging \
  < ~/.config/best.serp.co/staging-admin-token
```

`openssl rand -hex 24` is a 48-character key. The secret is trimmed before use, so a trailing
newline from the file can't make the key unusable.

**Revoke** with `pnpm exec wrangler secret delete STAGING_ADMIN_TOKEN --env staging`: every key is
refused. Decisions made with a key stay in the audit trail as `staging-agent`.

## Tests

`apps/web/src/lib/auth/staging-admin-key.test.ts` (the key's rules),
`apps/web/src/lib/admin/staging-agent.test.ts` (the route handlers on node:sqlite: an approval
and a tag recorded as `staging-agent`, the allowlist refused, production and local refused),
the "staging admin key in the Worker gate" block of `apps/web/src/lib/worker/handle-request.test.ts`,
`scripts/architecture-guard.test.ts` (one module reads the key, staging only), and
`apps/web/e2e/staging-access.spec.ts` (a local Worker serving as staging refuses the key).
