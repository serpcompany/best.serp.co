# Native submissions mockups (#70)

These are the clickable, owner-approved mockups for native submissions: every screen and email,
with state switchers, desktop and mobile widths, and light and dark themes. They are a design
reference, not part of the app.

- [`index.html`](./index.html): the built page. Open it in a browser. It loads Tailwind and the
  Geist fonts from public CDNs, so it needs a network connection.
- [`src/`](./src/build.sh): the parts it's built from. `sh src/build.sh` concatenates the scripts,
  runs `node --check` on them and rewrites `index.html`.
- [`COPY.md`](./COPY.md): visible copy, per state, for checkout (screen 4), the claim flow (8),
  listing page changes (9), admin Orders (13) and the claim-code, paid, held and refund emails.

## Approvals live on #70

[Issue #70](https://github.com/serpcompany/best.serp.co/issues/70) is the record. This page is
revision 5, the last approved revision. The owner approved:

- [all screens 1–17, including 2b, and the dashboard shell](https://github.com/serpcompany/best.serp.co/issues/70#issuecomment-6000082354);
- [revision 4](https://github.com/serpcompany/best.serp.co/issues/70#issuecomment-6000559709);
- [revision 5](https://github.com/serpcompany/best.serp.co/issues/70#issuecomment-6001471892)
  (screen 15).

After those approvals, the owner approved deviations in later comments on #70: the PR #76, #83,
#84 (D1–D10), #85 and #102 deviations, the #95 / PR #96 copy changes and the post-approval #102
copy. **Where a later approved deviation differs from this page, the deviation wins.** Read #70
before building from these mockups.

## How it was recovered

The design agent built the page in a scratchpad that was later deleted, and the only copy was the
published Artifact. This copy was rebuilt from the agent's transcript (session `148584b8`,
subagent `afb90c8f386050bb9`). Every scratchpad change was replayed in order: each `Write`,
`Edit` and file-changing Bash command (`sed -i`, the Python edit scripts, `head`/`rm`/`cp`, and
the edits to `build.sh`). The transcript's results showed which commands failed in the original,
and the replay failed at the same points.

- **Checks.** Each of the 15 `build.sh` runs in the transcript reported a byte size, and the replay
  matched every one. The final `index.html` is 251,765 bytes (SHA-256 `06f13db3…a0a457`). It is
  byte-identical to the body of the published revision 5 Artifact (version 6). All 18 screens and
  134 states render without script errors.
- **Steps that couldn't be replayed.** None of the steps that changed the parts. One `Edit` (on
  `f2-registry.js`) matched in the original only through the editor's quote normalization:
  `“` and `”` in `old_string` stood for `\u201c` and `\u201d` escapes in the file. The replay
  applied it the same way, and the build sizes confirm it.
- **Skipped on purpose.** Network-only steps (shadcn registry downloads, `gh` comments), two
  commands that the original sandbox refused, and the agent's own check scripts. None of them
  changed the parts.

Changes: `src/build.sh` now resolves paths from its own directory and writes `../index.html`, not
the scratchpad's `submissions-mockups.html`. The output is unchanged. Example products and URLs
in the mockups are fictional, so Biome and the link checker skip `.archive/`, where they now live.
