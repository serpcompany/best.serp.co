# Submission categories

What a Creator files a submission or revision under (#341, #406): one primary category (a hub,
required), up to three suggested tags, and optionally a category they suggest when none fits. The
rest of the intake is in [Submission flow](./submission-flow.md); the admin's side is in
[Admin panel](./admin-panel.md).

## Tags and retired categories (#341)

A Creator may suggest up to three active tags (on `/submit/` and the owner's listing edit),
stored in `tag_slugs`: null on a submission without tags, and on a revision whose tags equal the
listing's own. Approval and payment (`createListingFromSubmissionPlans`) give the new listing
the suggested tags still active, numbered from 0 in order. A revision approval replaces its
tags only when `tag_slugs` is not null; a paid listing's live approval never writes tags, since
payment did and an admin may have changed them since. A row saved before its narrow category
retired still goes live: `resolveStagedCategorySql` (`plan-support.ts`) files it under an
active category with that slug, else the hub of the active tag with that slug, else whatever the
old category's `taxonomy_redirects` row leads to (a merged slug's tag, a best page's tag or
category, or a category). The tag it finds comes first in a new or replaced set, or after a
revision's listing's own tags. New saves still require an active category.

## Suggested categories (#406)

When no category fits, a Creator may suggest one on `/submit/` or the owner's listing edit: a name
of at most 60 characters on one line and, once named, a note of at most 300, stored as
`suggested_category` and `suggested_category_note` (whose CHECKs hold the limits and refuse a note
alone). The primary category stays required, approval and payment never read the suggestion, and
the reviewer acts on it in `/admin` ([Admin panel](./admin-panel.md#category-suggestions-406)).
A draft edit that leaves it out keeps it; an empty name clears it. No message repeats the input.
