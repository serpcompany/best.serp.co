# Security policy

## Supported versions

Security fixes are made on the current `main` branch and deployed to the
best.serp.co production Worker. Older commits and unmaintained forks are not supported
release lines.

## Report a vulnerability privately

Do not open a public issue, pull request, discussion, or disclosure for a suspected
vulnerability. Use GitHub's **Security → Report a vulnerability** form for this
repository to start a private security advisory:

<https://github.com/serpcompany/best.serp.co/security/advisories/new>

Include the affected route or component, impact, reproduction steps, and any known
workaround. Do not include production credentials, personal data, or destructive
proof-of-concept traffic. The maintainers will acknowledge the report, assess its
severity, coordinate a fix and deployment, and agree on disclosure timing with the
reporter. If private vulnerability reporting is unavailable, contact a repository
owner privately and ask them to open a draft security advisory; do not fall back to
a public issue.

## Dependency findings

Automated dependency findings are triaged under the process in
[`docs/dependency-security.md`](./docs/dependency-security.md). A passing baseline-aware
audit means no new high or critical production advisory was introduced; it does not
mean the time-bounded baseline debt is resolved.
