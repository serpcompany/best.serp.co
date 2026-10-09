# Documentation index

| Document | Covers |
|---|---|
| [Architecture](./ARCHITECTURE.md) | Runtime boundaries and responsibilities |
| [URLs](./URLS.md) | Canonical URLs, redirects, pagination, sitemaps and structured data |
| [Caching](./CACHING.md) | The catalog epoch and the four cache layers |
| [Data model](./DATA_MODEL.md) | D1 schema, eligibility, caching, the initial import |
| [Development](./DEVELOPMENT.md) | Local catalog, Worker preview, schema changes |
| [Submission flow](./SUBMISSION_FLOW.md) | Public intake, badge verification, review |
| [Claims](./CLAIMS.md) | Claiming an existing listing: domain-email code, badge or payment |
| [Badge program](./BADGE_PROGRAM.md) | Weekly badge checks, rechecks, unpublishing, ownership removal |
| [Listing media](./MEDIA.md) | Hosted logos and images: R2 keys, D1 records, rendering, local media |
| [Media ingestion](./MEDIA_INGESTION.md) | Fetching a source, where the Worker hosts images, the media cron |
| [Media publishing](./MEDIA_PUBLISHING.md) | Catalog-wide media changes: upload plans, manifests, recovery, the legacy migration |
| [Image safety and media health](./MEDIA_HEALTH.md) | The listing image fallback, its guards, the weekly media check |
| [Email](./EMAIL.md) | Transactional email, environments, owner prerequisites |
| [Email templates](./EMAIL_TEMPLATES.md) | Every email, its trigger, recipient, and link |
| [Billing](./BILLING.md) | Paid listings: Stripe behind the billing module, orders, refunds |
| [Submitter dashboard](./ACCOUNT_DASHBOARD.md) | `/account`: statuses, edits, revisions, the badge panel |
| [Accounts](./ACCOUNTS.md) | Better Auth sign-in codes, admins, Cloudflare Access |
| [Admin panel](./ADMIN_PANEL.md) | `/admin` screens, decisions, the production-write exception |
| [Submissions mockups](./mockups/submissions/README.md) | The owner-approved #70 mockups and their copy |
| [Deploy runbook](./DEPLOY_RUNBOOK.md) | Environments, workflows and their guards, production release, recovery, post-deploy checks |
| [Deploy credentials](./DEPLOY_CREDENTIALS.md) | The Cloudflare API token, the GitHub environments that hold it, what a leak reaches |
| [Production D1 bootstrap](./PRODUCTION_BOOTSTRAP.md) | Importing the reviewed catalog into an empty production D1, its rehearsal and read-only checks |
| [Production cutover](./PRODUCTION_CUTOVER.md) | The finished move of best.serp.co from GitHub Pages to the Worker, and the canonical-host switch |
| [Telemetry](./TELEMETRY.md) | Sentry error reporting, GTM and Cloudflare Web Analytics |
| [D1 recovery](./D1_RECOVERY.md) | Undoing a production write with D1 Time Travel |
| [Catalog hygiene](./CATALOG_HYGIENE.md) | What the catalog lists (no adult products) and the listing domain check: hijacked, parked, and moved domains |
| [Release guards](./RELEASE_GUARDS.md) | `db:*` commands by target, promotion, staging before production, hotfixes |
| [Catalog publication](./CATALOG_PUBLICATION.md) | Catalog manifests and listing media plans: staging first, the publisher's and uploader's guards |
| [Credential guards](./CREDENTIAL_GUARDS.md) | Workflow jobs holding the Cloudflare token: no D1 exports, bookmarks before changes, the security boundary |
| [Promotion plan 2026-10-06](./releases/2026-10-06-promotion-plan.md) | The first staging → main promotion of the #59 work: blockers, order, rollback |
| [Website guide](../apps/web/docs/agents/web.md) | Design tokens, UI rules, layout blocks, page patterns |
| [Harness](./HARNESS.md) | Validation loops, runtime evidence, worktrees |
| [CI](./CI.md) | `web.yml` checks and staging deploy, rulesets, runners |
| [Dependency security](./DEPENDENCY_SECURITY.md) | Production dependency audit |
| [Issue tracker](./agents/issue-tracker.md) | Agent issue workflow configuration |
| [Triage labels](./agents/triage-labels.md) | Label conventions |
| [Domain docs](./agents/domain.md) | Shared vocabulary configuration |

Root navigation and non-negotiable rules live in [`AGENTS.md`](../AGENTS.md). Planning
lives in GitHub Issues on `serpcompany/best.serp.co`.
