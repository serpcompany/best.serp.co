# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root.
- **`docs/adr/`** — read ADRs that touch the area you are about to work in.

If either location does not exist, **proceed silently**. Do not flag its absence or suggest creating it upfront. The `/domain-modeling` skill creates domain files lazily when terminology or decisions are resolved.

## File structure

This repository uses a single-context layout:

```text
/
├── CONTEXT.md
├── docs/
│   └── adr/
│       ├── 0001-example-decision.md
│       └── 0002-example-decision.md
├── apps/
└── packages/
```

Do not add `CONTEXT-MAP.md` or package-local context glossaries unless the domain is deliberately split into independently named contexts.

## Use the glossary's vocabulary

When output names a domain concept in an issue title, refactor proposal, hypothesis, or test name, use the term defined in `CONTEXT.md`. Do not drift to synonyms the glossary explicitly avoids.

If the needed concept is absent, either reconsider whether the term belongs to the project or note the gap for the `/domain-modeling` workflow.

## Flag ADR conflicts

If proposed work contradicts an existing ADR, surface that conflict explicitly rather than silently overriding the decision:

> _Contradicts ADR-0007 (event-sourced orders) — but worth reopening because…_
