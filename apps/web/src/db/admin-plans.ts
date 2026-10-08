import { assertPreviousStatementChangedOne, type StatementPlan } from './plan-support'

/**
 * The admin allowlist as statement plans (serpcompany/best.serp.co#64 screen 14). An email on
 * `admin_allowlist` becomes an admin at its next sign-in (`syncUserRole`), and every admin
 * request checks the allowlist again (`getAdminStatus`), so removing an email revokes access on
 * the next request. The list never becomes empty: removing the last email is refused inside the
 * batch, so two admins removing each other at once cannot both succeed.
 */

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u

/** Lowercase and trimmed, as `admin_allowlist` and `users` store emails. */
function normalizeEmail(value: string): string {
  return value.trim().toLowerCase()
}

/** A normalized allowlist email, or an error for anything that is not an address. */
export function allowlistEmail(value: string): string {
  const email = normalizeEmail(value)
  if (!EMAIL.test(email) || email.length > 254) {
    throw new Error('An admin needs a valid email address.')
  }
  return email
}

/** Adds an email; refused (the batch fails) when it is already on the list. */
export function buildAddAdminPlans(input: {
  addedBy: string
  email: string
  note?: string
}): StatementPlan[] {
  const email = allowlistEmail(input.email)
  return [
    {
      sql: `INSERT INTO admin_allowlist (email,note,added_by)
        SELECT ?,?,? WHERE NOT EXISTS (SELECT 1 FROM admin_allowlist WHERE email=?)`,
      params: [email, input.note?.trim() ?? '', normalizeEmail(input.addedBy), email]
    },
    assertPreviousStatementChangedOne('admin_added')
  ]
}

/**
 * Removes an email, unless it is the last one on the list. The account keeps everything else
 * (its own submissions and listings); its role returns to `user` in the same batch.
 */
export function buildRemoveAdminPlans(input: { email: string }): StatementPlan[] {
  const email = allowlistEmail(input.email)
  return [
    {
      sql: `DELETE FROM admin_allowlist
        WHERE email=? AND (SELECT COUNT(*) FROM admin_allowlist) > 1`,
      params: [email]
    },
    assertPreviousStatementChangedOne('admin_removed'),
    { sql: `UPDATE users SET role='user' WHERE email=? AND role='admin'`, params: [email] }
  ]
}

/** Every allowlisted email in the order it was added, with the account name if one exists. */
export function selectAdminAllowlistPlan(): StatementPlan {
  return {
    sql: `SELECT a.email,a.note,a.added_by,a.created_at,u.name
      FROM admin_allowlist a LEFT JOIN users u ON u.email=a.email
      ORDER BY a.rowid`,
    params: []
  }
}

/** The account with this verified email, for an ownership transfer (#64). */
export function selectVerifiedUserByEmailPlan(email: string): StatementPlan {
  return {
    sql: `SELECT id,email,name,created_at FROM users WHERE email=? AND email_verified=1 LIMIT 1`,
    params: [normalizeEmail(email)]
  }
}
