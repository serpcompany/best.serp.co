# Credential guards

What a workflow job that holds the Cloudflare token may do, so D1 data never leaves Cloudflare
and every D1 change can be undone. `scripts/deploy-workflows.test.ts` enforces it in its
"D1 data stays in Cloudflare" tests, whose reviewed lists and comments hold the detail. The
release order itself is in [Release guards](./RELEASE_GUARDS.md).

## D1 data stays in Cloudflare

No workflow exports a D1 database. The repository is public, so any signed-in GitHub user can
download its workflow artifacts, and an export would hold session and OAuth tokens,
verification values, and submitter emails.

Instead, each workflow step that can change D1 directly follows a step running
`cloudflare-release.ts bookmark <env>`. That read-only command reads the D1 Time Travel
bookmark, writes it and the exact restore command to the run summary, and fails when it cannot.
The endpoint accepts D1 Read, which the deploy token's D1 → Edit includes. Only the owner
restores ([D1 recovery](./D1_RECOVERY.md#restore-a-workflow-bookmark)).

## Workflow checks

- **Changes are found by credential, and the check fails closed.** A step holds the token when
  its own `env` or `with`, its job's or workflow's `env`, or its job's `container` or
  `services` name a Wrangler credential variable in any case, or mention `secrets` anywhere
  other than as an exact `secrets.<name>` from a reviewed list. The text is matched, not parsed
  as expressions, so `secrets[...]`, `toJSON(secrets)`, a lower-case secret name, and a `}}`
  inside a string literal all count. Every such step is a D1 change, except a
  step whose whole `run` is one of a short reviewed list of commands that cannot change D1
  **and** that has nothing else to change what runs: no other step keys, no unreviewed `env`
  entry or value, no `shell` or `working-directory`, and no `defaults` or other `env` on the
  job or workflow. Any other launcher (a path to a binary, a script, an action) is a change, and
  so is any variant of a reviewed command. A bookmark step must meet the same rules.
- **No handoff.** A token step outside that list may not write `GITHUB_ENV`, `GITHUB_PATH`,
  `GITHUB_OUTPUT`, or `GITHUB_STATE`, so it cannot pass the token to a later step. In a job
  holding the token, no `run` step may write `GITHUB_ENV` or `GITHUB_PATH`, and the job may not
  set `container` or `services`, so nothing outside a step changes what an exempt command runs.
- **A change runs only after a successful bookmark.** Its bookmark is the step right before it
  in the same job, for the job's environment, with the same `if:`. Neither step may use
  `continue-on-error` or a status function (`always()`, `failure()`, `cancelled()`,
  `success()`), so the implicit `success()` skips the change when the bookmark fails. A change
  step that sets `CLOUDFLARE_D1_DATABASE_ID` must set its environment's database.
- **Token steps that change no D1.** The R2-only listing media upload and the weekly media
  health check hold the token, but their exact commands cannot change D1, so they need no
  bookmark; any variant of either still does. The health check's issue step holds no
  Cloudflare credential ([media health](./MEDIA_HEALTH.md#weekly-workflow)).
- **Nothing leaves as a file.** Only reviewed artifacts and caches are allowed (test evidence
  and the install action's dependency caches), matched by action, name, and path. No workflow
  or script exports D1. In every job where any step holds the token, each step uses only
  reviewed actions and runs no `gh gist`, `gh release upload|create`, `gh api` file field,
  `curl` file upload (`-T`, `--upload-file`, `-F`, `--form`, `-d @`, `--data*=@`), or `wget`
  post (`outboundUploads` in the test).

## Adding a credentialed job

A workflow change that gives a job `CLOUDFLARE_API_TOKEN` fails these tests until the reviewed
lists at the top of the "D1 data stays in Cloudflare" tests say what it does; the comment above
them gives the steps. Each entry is reviewed with the workflow.

## Known limits

These checks read workflow and script text, not data, and they are not a sandbox:

- A reviewed `pnpm` command runs repository code: a change to `cloudflare-release.ts` or a
  package script can do anything with the token, and only code review catches it.
- An upload by a program the parser does not name (`node -e`, `python -c`, `nc`, or a renamed
  copy of `curl`) is not caught, and neither is a file written in a credentialed job and sent
  from a job without the token.
- A `curl` body that carries data inline rather than from a file (`curl -d "$(cat out.json)"`)
  is not caught: only file uploads are.
- An allowlisted artifact or cache path, a log line, or a job summary could still carry data.
- A remote reusable workflow or action is judged by its reference, not its content.
- A pull request can edit the checks themselves.

Review of every workflow and script change stays the control; the per-environment token split
limits what a leaked token reaches.

## Security boundary

Until the token split, the release and credential guards are a process control, not a security
boundary.

- **Narrowed:** the `staging` environment allows deployments only from the `staging` branch,
  and `production` only from `main`, so only workflows on those branches can use their
  secrets.
- **Still open:** both environments still hold the same account-wide Cloudflare token
  ([deploy runbook](./DEPLOY_RUNBOOK.md#github-environments)), so a workflow merged to `staging`
  that uses the `staging` environment could still reach production directly. That path
  requires a pull request and the required checks, but no approving review.
- **No human gate on staging data:** the `staging` environment has no reviewers, so anything
  that can dispatch workflows can run the staging publication or upload. Agents never do
  (AGENTS.md); a `staging-data` environment would enforce it
  ([Listing media](./MEDIA.md#optional-owner-actions)).

The per-environment token split closes that path: decision b of serpcompany/best.serp.co#42,
which the owner approved for right after cutover and the runbook still lists as planned.
