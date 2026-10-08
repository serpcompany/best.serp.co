import { describe, expect, it } from 'vitest'
import {
  allowlistEmail,
  buildAddAdminPlans,
  buildRemoveAdminPlans,
  selectAdminAllowlistPlan,
  selectVerifiedUserByEmailPlan
} from './admin-plans'
import { execute, planDatabase, query } from './plan-test-support'

function allowlist(db: ReturnType<typeof planDatabase>): string[] {
  return (query(db, selectAdminAllowlistPlan()) as Array<{ email: string }>).map(row => row.email)
}

describe('admin allowlist plans (#64)', () => {
  it('starts from the seeded owner and adds a normalized email once', () => {
    const db = planDatabase()
    expect(allowlist(db)).toEqual(['devin@serp.co'])
    execute(db, buildAddAdminPlans({ addedBy: 'Devin@serp.co', email: '  Alex@SERP.co ' }))
    expect(query(db, selectAdminAllowlistPlan())).toMatchObject([
      { added_by: 'migration:0002_better_auth', email: 'devin@serp.co' },
      { added_by: 'devin@serp.co', email: 'alex@serp.co', name: null }
    ])
    expect(() =>
      execute(db, buildAddAdminPlans({ addedBy: 'devin@serp.co', email: 'alex@serp.co' }))
    ).toThrow(/malformed JSON/u)
    expect(allowlist(db)).toEqual(['devin@serp.co', 'alex@serp.co'])
  })

  it('removes an admin, resets their role, and never removes the last one', () => {
    const db = planDatabase()
    db.exec(`
      INSERT INTO admin_allowlist (email, added_by) VALUES ('owner@example.com', 'devin@serp.co');
      UPDATE users SET role='admin' WHERE email='owner@example.com';`)
    execute(db, buildRemoveAdminPlans({ email: 'owner@example.com' }))
    expect(allowlist(db)).toEqual(['devin@serp.co'])
    expect(db.prepare("SELECT role FROM users WHERE email='owner@example.com'").get()).toEqual({
      role: 'user'
    })
    expect(() => execute(db, buildRemoveAdminPlans({ email: 'devin@serp.co' }))).toThrow(
      /malformed JSON/u
    )
    expect(() => execute(db, buildRemoveAdminPlans({ email: 'nobody@example.com' }))).toThrow(
      /malformed JSON/u
    )
    expect(allowlist(db)).toEqual(['devin@serp.co'])
  })

  it('refuses anything that is not an email address', () => {
    for (const value of ['', 'devin', 'devin@serp', 'a b@serp.co']) {
      expect(() => allowlistEmail(value), value).toThrow(/valid email/u)
    }
    expect(allowlistEmail(' Devin@Serp.Co ')).toBe('devin@serp.co')
  })

  it('finds a verified account by email for a transfer', () => {
    const db = planDatabase()
    db.exec(`INSERT INTO users (id, name, email, email_verified)
      VALUES ('user_unverified', 'U', 'unverified@example.com', 0)`)
    expect(query(db, selectVerifiedUserByEmailPlan(' Owner@Example.com'))).toMatchObject([
      { email: 'owner@example.com', id: 'user_owner' }
    ])
    expect(query(db, selectVerifiedUserByEmailPlan('unverified@example.com'))).toEqual([])
  })
})
