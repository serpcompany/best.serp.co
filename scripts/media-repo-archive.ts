import { spawnSync } from 'node:child_process'
import { posix } from 'node:path'

/**
 * Listing media files that the reviewed legacy media plan
 * (`d1/media/2026-10-06-legacy-media.json`) read as `repo:` sources, deleted once production had
 * published every manifest naming their keys (serpcompany/best.serp.co#124). The plan keeps their
 * `repo:` paths as the record of where the uploaded bytes came from, and the bytes stay in Git at
 * `ARCHIVED_REPO_MEDIA_COMMIT`, the last commit that held all of them (#120). The legacy media
 * migration reads an archived file from there, so a replay hosts the same bytes under the same
 * keys. The R2-only uploader never does (`deploy-workflows.test.ts` pins its imports): a dry run
 * or rerun of the plan needs the files restored first, `git restore --source=<commit> -- <dir>`.
 */
export const ARCHIVED_REPO_MEDIA_COMMIT = '0e17a98e201524e90d946200a9c71d3816f5f4c3'

/** The deleted directories, relative to the repository root. */
export const ARCHIVED_REPO_MEDIA_DIRECTORIES = [
  'apps/web/public/listing-logos/serpdownloaders.com/',
  'apps/web/public/listing-media-seed/',
  'apps/web/public/media/products/launchbuzz.io/'
] as const

/** Whether a repository-relative path lies in a deleted directory. Needs no Git history. */
export function isArchivedRepoMedia(path: string): boolean {
  return (
    posix.normalize(path) === path &&
    ARCHIVED_REPO_MEDIA_DIRECTORIES.some(directory => path.startsWith(directory))
  )
}

let archivePresent: boolean | undefined

/** Whether this checkout holds the archive commit. A shallow CI checkout does not. */
export function hasRepoMediaArchive(): boolean {
  archivePresent ??=
    spawnSync('git', ['cat-file', '-e', `${ARCHIVED_REPO_MEDIA_COMMIT}^{commit}`], {
      stdio: 'ignore'
    }).status === 0
  return archivePresent
}

/**
 * An archived path's bytes at the archive commit, or null when the path is not archived or that
 * commit held no such file. Throws when the checkout lacks the commit, so a shallow clone is never
 * mistaken for a missing file.
 */
export function readArchivedRepoMedia(path: string): Uint8Array | null {
  if (!isArchivedRepoMedia(path)) return null
  if (!hasRepoMediaArchive()) {
    throw new Error(
      `${path} was deleted in #124 and this checkout lacks commit ${ARCHIVED_REPO_MEDIA_COMMIT}: ` +
        'fetch the full history (git fetch --unshallow), or restore the file with ' +
        `git restore --source=${ARCHIVED_REPO_MEDIA_COMMIT} -- ${path}`
    )
  }
  const blob = spawnSync('git', ['cat-file', 'blob', `${ARCHIVED_REPO_MEDIA_COMMIT}:${path}`], {
    maxBuffer: 64 * 1024 * 1024
  })
  return blob.status === 0 ? new Uint8Array(blob.stdout) : null
}
