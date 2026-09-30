# D1 replacement cutover record

Status: completed on 2026-09-25

Governing issue: [#72](https://github.com/serpcompany/directory-platform-d1/issues/72)

Final commit: `11813bb73facaeece37acbe56c9e09018c944867`

This is the retained operational record for the completed legacy-to-Drizzle D1
cutover. It is not an instruction to rerun the migration. The one-time preparation,
provisioning, Preview rehearsal, Production cutover, rollback, and finalization
workflows are disabled in GitHub Actions.

## Active identities

| Site and environment | Worker | Active Drizzle D1 |
| --- | --- | --- |
| SERP Preview | `serp-software-replatform-preview` | `serp-software-replatform-preview` (`29c0a6ed-e824-459c-b088-6098fdbf1abf`) |
| SERP Production | `serp-software-production` | `serp-software-replatform-production` (`7d525a45-318b-4227-9463-19f4e9cb6eb6`) |
| PVD Preview | `pornvideodownloaders-preview` | `pornvideodownloaders-replatform-preview` (`16ede356-3caa-4cea-93f3-69f5b208b1d7`) |
| PVD Production | `pornvideodownloaders-production` | `pornvideodownloaders-replatform-production` (`8f5097c5-7c11-4505-bc59-b41cb4c86100`) |

Routine protected releases must explicitly select `D1_RELEASE_GENERATION=replatform`,
the replacement identity secrets, replacement Wrangler templates, and `d1/drizzle/`.
The inactive source identities are never routine release targets.

## Final evidence

| Evidence | SERP | Porn Video Downloaders |
| --- | --- | --- |
| Exact-main Preview | [run 36115385232](https://github.com/serpcompany/directory-platform-d1/actions/runs/36115385232) | [run 36115388257](https://github.com/serpcompany/directory-platform-d1/actions/runs/36115388257) |
| Production cutover | [run 36116735503](https://github.com/serpcompany/directory-platform-d1/actions/runs/36116735503) | [run 36117600807](https://github.com/serpcompany/directory-platform-d1/actions/runs/36117600807) |
| Finalization | [run 36117390347](https://github.com/serpcompany/directory-platform-d1/actions/runs/36117390347) | [run 36118472672](https://github.com/serpcompany/directory-platform-d1/actions/runs/36118472672) |
| Cutover ID | `serp-software-6f8eb0d-20260925` | `pvd-11813bb-20260925` |
| Receipt SHA-256 | `6f7121291915f2910a29cd3b72046bb111cd2e94c05d0a5c52bcf09715f29a8e` | `4addd60c77987a92a34a4551f16999b35f0ff3f39c64a9b8b2fc7c4c92e8dca6` |
| Active target version | `0c50b425-e4d8-4277-931a-a9fd2406d132` | `172433ff-2c27-48d7-8567-5c41fd8ecc9b` |

Both exact-main Preview rehearsals proved fresh schema application, exact parity,
repeat import no-op, Catalog journeys, isolated Submission journeys, rollback and
restoration, sealed receipts, and transient-authority cleanup. Both Production runs
captured one stable locked 17-table snapshot, imported and verified exact parity,
rehearsed immutable-version rollback, restored the target version, and retained
90-day evidence. Finalization revalidated the active target and unlocked only that
replacement database.

## Retained source databases

The former Production databases are unbound from every Worker, remain locked, and
must not be repurposed or deleted before the recorded evidence expires:

| Site | Retained source | Minimum retention deadline |
| --- | --- | --- |
| SERP | `serp-software-directory-db` (`dda690b0-19c1-4d7e-a3c8-da2a9e3216a8`) | `2026-12-24T09:15:12Z` |
| PVD | `pornvideo-downloaders-production` (`d934a6c2-b382-4c50-a220-1e9dc0e5f8e5`) | `2026-12-24T09:26:48Z` |

The historical `d1/migrations/0001`-`0009` lineage, cutover receipts, source/target
exports, and source identity secrets remain recovery evidence until that deadline.

## Recovery boundary

The checked-in rollback workflow is not directly executable after finalization:
it requires both cutover locks to be active, while finalization marked the active
replacement lock successful. In addition, writes may now exist only in the active
replacement database. Do not present a Worker-version rollback to the retained source
as a safe live rollback and do not bypass the workflow's lock checks.

If recovery is required, first freeze all writes, determine whether post-cutover
writes exist, review the retained exports and receipts, and design a separately
reviewed forward recovery or replay. Production D1 queries, restores, binding changes,
and deletions still require explicit protected authorization.

## Deferred cleanup

After both retention deadlines:

1. verify current Worker bindings and routes account-wide;
2. confirm retained artifacts and any required export have been preserved;
3. confirm no workflow or environment consumes the source identities;
4. obtain separate approval for each exact database deletion;
5. delete only the approved sources and record Cloudflare receipts; and
6. remove the retired lineage, cutover-only code, environment values, and workflows
   in a reviewed pull request.

The two unbound source Preview databases were deleted through a protected,
main-only workflow after explicit authorization:

- `serp-software-replatform-source-preview`
  (`5e96a9f0-e11a-4c60-8dd3-02299c032466`):
  [run 36124973769](https://github.com/serpcompany/directory-platform-d1/actions/runs/36124973769),
  export and receipts retained through `2026-12-24T10:37:28Z`;
- `pornvideo-downloaders-preview` (`f92694b0-af7d-4c13-91f2-ee0393af9bdd`):
  [run 36125338098](https://github.com/serpcompany/directory-platform-d1/actions/runs/36125338098),
  export and receipts retained through `2026-12-24T10:41:30Z`.

Both final receipts record `action=deleted`; account inventory and public HTTP checks
re-proved the active replacement Preview databases and Worker bindings afterward.
The temporary OAuth and retired Preview identity secrets were removed, and the
single-use deletion executor was removed after its receipts were verified. This
grants no authority over either retained
Production source, which remains governed by Issue #88 and the deadlines above.
