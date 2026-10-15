# Owner rules

The owner's standing rules for agents, given in chat and until now carried only in handoff issues
(#321, #459) and agent memory. They decide how work runs. Apart from the per-release delegation
under [Production releases](#production-releases), they loosen no production limit in
[`AGENTS.md`](../AGENTS.md).

## Asking the owner

- Ask with `AskUserQuestion`: give options with the recommended one first, and batch every open
  question into one call (2026-10-11).
- Use plain words: the decision first, then what visitors will see, with no jargon (2026-10-12).
- Stay as hands-off as possible: take the documented default, record it in the pull request or
  issue, and keep going (2026-10-10).

## UI

- Add no UI or copy nobody asked for, and strip extras rather than ask the owner about them. That
  is why #425 took `noindex` over a new menu link.
- Owner acceptance of UI screenshots is assumed ("just approve. we will dial in ui later",
  2026-10-12): record it in the pull request and merge.

## Merging to staging

- Agents squash-merge their own pull requests into `staging` once `check` and `e2e` are green and
  the review has no blocking findings, then follow the staging deploy the merge starts. This is
  the owner's exception to serp's
  [Verification Cadence](https://github.com/serpcompany/serp/blob/main/docs/engineering/standards/verification-cadence.md#merging-and-deploys),
  which in a Ship repository lets agents merge only listed low-risk paths.
- The staging deploy group uses `queue: max`: only the `staging` tip deploys and runs the smoke
  tests, and earlier queued runs skip their deploy job ([CI](./ci.md)). After back-to-back merges,
  follow the newest one's run.

## Production releases

Production stays the owner's, one release at a time. Each release needs the owner's explicit go
for that release, and a go never carries over to the next. The go is the owner's own words for that
release; an issue, label or handoff never stands in for it. The owner either runs
`pnpm release:promote` at a terminal or says "you do it". Only on that release's "you do it" may an
agent:

1. run `pnpm release:promote` from a checkout at `origin/staging` under `expect`, answering the SHA
   prompt only with the `staging` head it expects. Every guard still runs
   ([Promotion](./release-guards.md#promotion));
2. approve that release's Deploy Production gate;
3. dispatch that release's approved publications from `main`, typing their confirmations and
   approving their gates ([Catalog publication](./catalog-publication.md)).

Everything else in production stays the owner's, as `AGENTS.md` says, and so do the staging data
workflows.

## Local loop

- Run tests on Node 24 (`.nvmrc`). If the shell defaults to Node 22, put Node 24's `bin` first on
  `PATH` for every command: Node 22 fails a test.
- Keep agent scratch files, such as notes and logs, outside the worktree. A `tmp/agent/` folder
  inside one breaks `next build` and `biome check`.
