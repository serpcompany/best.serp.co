# Documentation index

Each doc covers one topic. Open the one whose "read it when" matches the task.

| Document | Covers | Read it when |
|---|---|---|
| [Architecture](./ARCHITECTURE.md) | Runtime boundaries and responsibilities | You change the Worker entry, a binding, an environment or host rule, or which layer owns what |
| [URLs](./URLS.md) | Canonical URLs, redirects, pagination, sitemaps and structured data | You add a route, a redirect, a sitemap, or structured data |
| [Caching](./CACHING.md) | The catalog epoch and the four cache layers | You change what a page caches, or a change isn't showing |
| [Data model](./DATA_MODEL.md) | D1 schema, eligibility, caching, the initial import | You touch a table, a query, what a page may show, or the catalog caches |
| [Development](./DEVELOPMENT.md) | Local catalog, Worker preview, schema changes | You set up a checkout, run the Worker locally, or change the schema |
| [Submission flow](./SUBMISSION_FLOW.md) | Public intake, badge verification, review | You change `/submit` or how a submission reaches review |
| [Claims](./CLAIMS.md) | Claiming an existing listing: domain-email code, badge or payment | You change the claim link, its checks, or ownership |
| [Badge program](./BADGE_PROGRAM.md) | Weekly badge checks, rechecks, unpublishing, ownership removal | You change the badge crons or what a failed check does |
| [Listing media](./MEDIA.md) | Hosted logos and images: R2 keys, ingestion, the media cron | You add, host or move a listing image |
| [Image safety and media health](./MEDIA_HEALTH.md) | The listing image fallback, its guards, the weekly media check | You render a listing image or change the media check |
| [Email](./EMAIL.md) | Transactional email, environments, owner prerequisites | You send mail or change where it may go |
| [Email templates](./EMAIL_TEMPLATES.md) | Every email, its trigger, recipient, and link | You add or reword an email |
| [Billing](./BILLING.md) | Paid listings: Stripe behind the billing module, orders, refunds | You touch a payment, an order, or the billing sweep |
| [Submitter dashboard](./ACCOUNT_DASHBOARD.md) | `/account`: statuses, edits, revisions, the badge panel | You change a `/account` screen |
| [Accounts](./ACCOUNTS.md) | Better Auth sign-in codes, admins, Cloudflare Access | You change sign-in, sessions, the dashboard shell, or the admin gate |
| [Admin panel](./ADMIN_PANEL.md) | `/admin` screens, decisions, the production-write exception | You change an `/admin` screen or a decision it writes |
| [Deploy runbook](./DEPLOY_RUNBOOK.md) | Environments, release flow, cutover checklist | Before any Cloudflare operation or release |
| [Telemetry](./TELEMETRY.md) | Sentry error reporting, GTM and Cloudflare Web Analytics | You add logging, error reporting, or analytics |
| [D1 recovery](./D1_RECOVERY.md) | Undoing a production write with D1 Time Travel | A production write needs undoing |
| [Catalog hygiene](./CATALOG_HYGIENE.md) | What the catalog lists (no adult products) and the listing domain check: hijacked, parked, and moved domains | You add or remove listings, change the domain check, or touch the listing FAQs' `faqsToShow` stopgap |
| [Release guards](./RELEASE_GUARDS.md) | `db:*` commands by target, promotion, staging before production, hotfixes | You run a `db:*` command, promote `staging`, open a `hotfix-*` pull request, or change a release workflow |
| [Website guide](../apps/web/docs/agents/web.md) | Design tokens, UI rules, layout blocks, page patterns | You change how a page looks, add a component, or build a page |
| [Harness](./HARNESS.md) | Validation loops, runtime evidence, worktrees | You validate a change, capture runtime evidence, or start a worktree |
| [CI](./CI.md) | `web.yml` checks and staging deploy, rulesets, runners | A check fails in CI, or you change a workflow |
| [Dependency security](./DEPENDENCY_SECURITY.md) | Production dependency audit | You add or upgrade a dependency, or the audit fails |
| [Issue tracker](./agents/issue-tracker.md) | Agent issue workflow configuration | You file, label or close an issue |
| [Triage labels](./agents/triage-labels.md) | Label conventions | You triage an issue |
| [Domain docs](./agents/domain.md) | Shared vocabulary configuration | You name a domain concept |

Root navigation and non-negotiable rules live in [`AGENTS.md`](../AGENTS.md). Planning
lives in GitHub Issues on `serpcompany/best.serp.co`. History, such as the first promotion plan
and the #70 submission mockups with their approved copy, is in `.archive/`: it explains how a
decision came about, but it doesn't override these docs or the code.
