Closes #

<!--
Base: `staging`. Only `hotfix-*` branches target `main`; staging reaches main by the owner's
fast-forward promotion, not a pull request (docs/release-guards.md#promotion).
Title: a Conventional Commit describing the outcome a visitor or maintainer notices
(`fix: legal pages name working contact addresses`). The PR is squash-merged with this
title, so it is the changelog line. See serpcompany/serp docs/engineering/standards/git-workflow.md.
-->

## What changed

## Deliberately not included

## Evidence

Report each level separately; a lower level never proves a higher one.

- Build:
- Automated tests (`pnpm check`, CI run):
- UI / browser (Playwright, screenshots):
- Deployed (staging run, Playwright smoke, live-route checks):
- Owner acceptance:

Review: <rounds>, <outcome> (a fresh review agent; the author never reviews its own PR)

> **Note:** best.serp.co is D1-backed. Public intake is staged in normalized D1
> tables and versioned maintainer publications live under `d1/publications/`;
> catalog JSON files are forbidden. Only the owner merges.
