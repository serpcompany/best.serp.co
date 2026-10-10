/**
 * The `/submit` form's local draft (#63): what a visitor typed before signing in, kept in this
 * browser's `localStorage` so it survives the email-code sign-in and comes back on `/submit`.
 * It holds only what the visitor entered (never a token, a session, or a submission id), and is
 * cleared once the draft is saved to their account. Storage that is unavailable or full is
 * ignored: the form still works, it just won't remember.
 *
 * Shared computers (PR #84 review round 1, finding 8): signed out, the draft lives under one
 * anonymous key; signed in, under a key for that account, which adopts the anonymous draft on
 * the way back from sign-in. Signing out clears every draft key, so the next person to sign in
 * never sees someone else's draft.
 */

export const SUBMIT_DRAFT_STORAGE_KEY = 'bsc_submit_draft_v1'

/** The storage key for a signed-in account's draft, or the anonymous one. */
export function draftStorageKey(userId: string | null): string {
  return userId ? `${SUBMIT_DRAFT_STORAGE_KEY}:u:${userId}` : SUBMIT_DRAFT_STORAGE_KEY
}
/** A local draft older than this is ignored (drafts in an account last 30 days). */
const LOCAL_DRAFT_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000

export type LogoChoice = 'site-icon' | 'social-image' | 'url'

export interface LocalSubmitDraft {
  categorySlug: string
  content: string
  description: string
  /** Fields the prefill filled and the visitor has not changed since, with their source. */
  filled: Partial<Record<'description' | 'logo' | 'name', string>>
  logoChoice: LogoChoice | null
  logoUrl: string
  name: string
  savedAt: number
  siteIcon: string | null
  socialImage: string | null
  /** The suggested tags (#341), at most three. */
  tagSlugs: string[]
  website: string
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

function nullableUrl(value: unknown): string | null {
  return typeof value === 'string' && /^https?:\/\//iu.test(value) ? value.slice(0, 2048) : null
}

/** Parses stored JSON defensively: anything malformed yields null. */
export function parseLocalDraft(raw: string | null, now = Date.now()): LocalSubmitDraft | null {
  if (!raw) return null
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const savedAt = typeof record.savedAt === 'number' ? record.savedAt : 0
  if (!savedAt || now - savedAt > LOCAL_DRAFT_LIFETIME_MS) return null
  const filled: LocalSubmitDraft['filled'] = {}
  if (record.filled && typeof record.filled === 'object') {
    for (const key of ['description', 'logo', 'name'] as const) {
      const source = (record.filled as Record<string, unknown>)[key]
      if (typeof source === 'string') filled[key] = source.slice(0, 40)
    }
  }
  const logoChoice = ['site-icon', 'social-image', 'url'].includes(String(record.logoChoice))
    ? (record.logoChoice as LogoChoice)
    : null
  const draft: LocalSubmitDraft = {
    categorySlug: text(record.categorySlug, 100),
    content: text(record.content, 6000),
    description: text(record.description, 400),
    filled,
    logoChoice,
    logoUrl: text(record.logoUrl, 2048),
    name: text(record.name, 200),
    savedAt,
    siteIcon: nullableUrl(record.siteIcon),
    socialImage: nullableUrl(record.socialImage),
    tagSlugs: Array.isArray(record.tagSlugs)
      ? record.tagSlugs
          .filter((slug): slug is string => typeof slug === 'string')
          .slice(0, 3)
          .map(slug => slug.slice(0, 100))
      : [],
    website: text(record.website, 2048)
  }
  return draft.website || draft.name || draft.description || draft.content ? draft : null
}

/**
 * The draft for `userId` (or the anonymous one). A signed-in account without its own draft
 * adopts the anonymous one: the visitor who filled in the form and then signed in.
 */
export function readLocalDraft(userId: string | null): LocalSubmitDraft | null {
  try {
    const storage = window.localStorage
    const own = parseLocalDraft(storage.getItem(draftStorageKey(userId)))
    if (own || !userId) return own
    const anonymous = storage.getItem(SUBMIT_DRAFT_STORAGE_KEY)
    const adopted = parseLocalDraft(anonymous)
    if (adopted && anonymous) {
      storage.setItem(draftStorageKey(userId), anonymous)
      storage.removeItem(SUBMIT_DRAFT_STORAGE_KEY)
    }
    return adopted
  } catch {
    return null
  }
}

export function writeLocalDraft(
  draft: Omit<LocalSubmitDraft, 'savedAt'>,
  userId: string | null
): void {
  try {
    window.localStorage.setItem(
      draftStorageKey(userId),
      JSON.stringify({ ...draft, savedAt: Date.now() })
    )
  } catch {
    // Storage disabled or full: the form keeps working without remembering.
  }
}

export function clearLocalDraft(userId: string | null): void {
  try {
    window.localStorage.removeItem(draftStorageKey(userId))
    window.localStorage.removeItem(SUBMIT_DRAFT_STORAGE_KEY)
  } catch {
    // Nothing to clear.
  }
}

/** Removes every draft this browser keeps, anonymous or per account: on sign-out. */
export function clearAllLocalDrafts(): void {
  try {
    const storage = window.localStorage
    const keys: string[] = []
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index)
      if (key === SUBMIT_DRAFT_STORAGE_KEY || key?.startsWith(`${SUBMIT_DRAFT_STORAGE_KEY}:`)) {
        keys.push(key)
      }
    }
    for (const key of keys) storage.removeItem(key)
  } catch {
    // Storage unavailable (or no window): nothing is kept.
  }
}
