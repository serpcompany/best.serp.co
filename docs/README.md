# Documentation index

| Document | Covers |
|---|---|
| [Architecture](./ARCHITECTURE.md) | Runtime boundaries and responsibilities |
| [Data model](./DATA_MODEL.md) | D1 schema, eligibility, caching, the initial import |
| [Development](./DEVELOPMENT.md) | Local catalog, Worker preview, schema changes |
| [Submission flow](./SUBMISSION_FLOW.md) | Public intake, badge verification, review |
| [Badge program](./BADGE_PROGRAM.md) | Weekly badge checks, rechecks, unpublishing, ownership removal |
| [Listing media](./MEDIA.md) | Hosted logos and images: R2 keys, ingestion, the media cron |
| [Image safety and media health](./MEDIA_HEALTH.md) | The listing image fallback, its guards, the weekly media check |
| [Email](./EMAIL.md) | Transactional email, environments, owner prerequisites |
| [Email templates](./EMAIL_TEMPLATES.md) | Every email, its trigger, recipient, and link |
| [Submitter dashboard](./ACCOUNT_DASHBOARD.md) | `/account`: statuses, edits, revisions, the badge panel |
| [Accounts](./ACCOUNTS.md) | Better Auth sign-in codes, admins, Cloudflare Access |
| [Admin panel](./ADMIN_PANEL.md) | `/admin` screens, decisions, the production-write exception |
| [Submissions mockups](./mockups/submissions/README.md) | The owner-approved #70 mockups and their copy |
| [Deploy runbook](./DEPLOY_RUNBOOK.md) | Environments, release flow, cutover checklist |
| [D1 recovery](./D1_RECOVERY.md) | Undoing a production write with D1 Time Travel |
| [Catalog hygiene](./CATALOG_HYGIENE.md) | The listing domain check: hijacked, parked, and moved domains |
| [Release guards](./RELEASE_GUARDS.md) | `db:*` commands by target, staging before production |
| [Promotion plan 2026-10-06](./releases/2026-10-06-promotion-plan.md) | The first staging → main promotion of the #59 work: blockers, order, rollback |
| [Harness](./HARNESS.md) | Validation loops, runtime evidence, worktrees |
| [Dependency security](./DEPENDENCY_SECURITY.md) | Production dependency audit |
| [Issue tracker](./agents/issue-tracker.md) | Agent issue workflow configuration |
| [Triage labels](./agents/triage-labels.md) | Label conventions |
| [Domain docs](./agents/domain.md) | Shared vocabulary configuration |

Root navigation and non-negotiable rules live in [`AGENTS.md`](../AGENTS.md). Planning
lives in GitHub Issues on `serpcompany/best.serp.co`.
