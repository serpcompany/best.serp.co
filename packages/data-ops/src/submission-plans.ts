export interface SubmissionStatementPlan {
  params: unknown[]
  sql: string
}

export interface SubmissionApprovalSnapshot {
  checksum: string
  listingId: string | null
  slug: string
  status: 'approved' | 'pending_badge' | 'rejected' | 'verified'
  version: number
}

const CHANNEL = 'github_issue'

/**
 * SQLite evaluates only the selected CASE branch. A zero-row or multi-row
 * conditional transition therefore reaches malformed JSON and fails the D1
 * batch, while an exact one-row transition stays on the success branch.
 */
export function assertPreviousStatementChangedOne(label: string): SubmissionStatementPlan {
  return {
    sql: `SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('', '$') END /* ${label} */`,
    params: []
  }
}

export function selectSubmissionForDecisionPlan(submissionId: string): SubmissionStatementPlan {
  return {
    sql: `SELECT s.id,s.slug,s.status,s.listing_id,ps.version,ps.checksum
      FROM listing_submissions s JOIN publication_state ps ON ps.id=1
      WHERE s.id=?`,
    params: [submissionId]
  }
}

export function buildRejectSubmissionPlans(input: {
  now: string
  reviewer: string
  submissionId: string
}): SubmissionStatementPlan[] {
  return [
    {
      sql: `UPDATE listing_submissions SET status='rejected',reviewed_at=?,reviewed_by=?,updated_at=?
        WHERE id=? AND status IN ('pending_badge','verified')`,
      params: [input.now, input.reviewer, input.now, input.submissionId]
    },
    assertPreviousStatementChangedOne('submission_rejected'),
    {
      sql: `INSERT INTO listing_submission_events (submission_id,event_type,actor)
        VALUES (?,'rejected',?)`,
      params: [input.submissionId, input.reviewer]
    }
  ]
}

export function buildApproveSubmissionPlans(input: {
  afterChecksum: string
  affectedRoute: string
  beforeChecksum: string
  listingId: string
  manifestId: string
  now: string
  reviewer: string
  runId: string
  submissionId: string
  version: number
}): SubmissionStatementPlan[] {
  const nextVersion = input.version + 1
  return [
    {
      sql: `INSERT INTO publication_runs
        (id,manifest_id,base_version,input_checksum,affected_records,affected_routes,outcome,
         started_at,actor,workflow,before_checksum,after_checksum)
        SELECT ?,?,?,?,1,?,'started',?,?,?, ?,?
        WHERE EXISTS (SELECT 1 FROM listing_submissions
          WHERE id=? AND status='verified' AND listing_id IS NULL)
          AND EXISTS (SELECT 1 FROM publication_state
          WHERE id=1 AND version=? AND checksum=?)`,
      params: [
        input.runId,
        input.manifestId,
        input.version,
        input.afterChecksum,
        input.affectedRoute,
        input.now,
        input.reviewer,
        'github/approve-d1-submission',
        input.beforeChecksum,
        input.afterChecksum,
        input.submissionId,
        input.version,
        input.beforeChecksum
      ]
    },
    assertPreviousStatementChangedOne('approval_snapshot_current'),
    {
      sql: `INSERT INTO listings
        (id,slug,name,description,website,content,is_unofficial,is_featured,is_active,status,
         source_kind,source_identity,checksum,display_order)
        SELECT ?,slug,name,description,website,content,0,0,1,'draft',
          'verified-submission',id,?,COALESCE((SELECT MAX(display_order)+1 FROM listings),0)
        FROM listing_submissions WHERE id=? AND status='verified' AND listing_id IS NULL`,
      params: [input.listingId, input.afterChecksum, input.submissionId]
    },
    assertPreviousStatementChangedOne('draft_listing_created'),
    {
      sql: `INSERT INTO listing_categories (listing_id,category_id,sort_order,is_primary)
        SELECT ?,c.id,0,1 FROM listing_submissions s JOIN categories c
          ON c.slug=s.category_slug AND c.is_active=1
        WHERE s.id=? AND s.status='verified'`,
      params: [input.listingId, input.submissionId]
    },
    assertPreviousStatementChangedOne('primary_category_created'),
    {
      sql: `INSERT INTO listing_media (listing_id,kind,url,sort_order)
        SELECT ?,'logo',logo_url,0 FROM listing_submissions
        WHERE id=? AND status='verified'`,
      params: [input.listingId, input.submissionId]
    },
    assertPreviousStatementChangedOne('logo_created'),
    {
      sql: `INSERT INTO listing_media (listing_id,kind,url,sort_order)
        SELECT ?,'video',video_url,1 FROM listing_submissions
        WHERE id=? AND status='verified' AND video_url IS NOT NULL`,
      params: [input.listingId, input.submissionId]
    },
    {
      sql: `INSERT INTO listing_resource_links (listing_id,label,url,sort_order)
        SELECT ?,label,url,sort_order FROM listing_submission_resource_links
        WHERE submission_id=? ORDER BY sort_order`,
      params: [input.listingId, input.submissionId]
    },
    {
      sql: `INSERT INTO listing_faqs (listing_id,question,answer,sort_order)
        SELECT ?,question,answer,sort_order FROM listing_submission_faqs
        WHERE submission_id=? ORDER BY sort_order`,
      params: [input.listingId, input.submissionId]
    },
    {
      sql: `UPDATE listings SET status='approved',published_at=?,updated_at=?
        WHERE id=? AND status='draft' AND source_kind='verified-submission'
          AND source_identity=?`,
      params: [input.now, input.now, input.listingId, input.submissionId]
    },
    assertPreviousStatementChangedOne('listing_published'),
    {
      sql: `UPDATE listing_submissions SET status='approved',listing_id=?,reviewed_at=?,reviewed_by=?,updated_at=?
        WHERE id=? AND status='verified' AND listing_id IS NULL`,
      params: [input.listingId, input.now, input.reviewer, input.now, input.submissionId]
    },
    assertPreviousStatementChangedOne('submission_approved'),
    {
      sql: `INSERT INTO listing_submission_events (submission_id,event_type,actor)
        VALUES (?,'approved',?)`,
      params: [input.submissionId, input.reviewer]
    },
    {
      sql: `UPDATE publication_state SET version=version+1,manifest_id=?,checksum=?,published_at=?
        WHERE id=1 AND version=? AND checksum=?`,
      params: [
        input.manifestId,
        input.afterChecksum,
        input.now,
        input.version,
        input.beforeChecksum
      ]
    },
    assertPreviousStatementChangedOne('publication_state_advanced'),
    {
      sql: `UPDATE publication_runs SET outcome='succeeded',published_version=?,completed_at=?
        WHERE id=? AND outcome='started'`,
      params: [nextVersion, input.now, input.runId]
    },
    assertPreviousStatementChangedOne('publication_audit_completed')
  ]
}

export function selectVerifiedSubmissionNotificationPlans(
  limit: number
): SubmissionStatementPlan[] {
  const pending = `SELECT candidate.id FROM listing_submissions candidate
    LEFT JOIN listing_submission_notifications notification
      ON notification.submission_id=candidate.id AND notification.channel=?
    WHERE candidate.status='verified'
      AND (notification.submission_id IS NULL OR notification.preview_token_hash IS NULL)
    ORDER BY candidate.badge_verified_at,candidate.created_at LIMIT ?`
  const params = [CHANNEL, limit]
  return [
    {
      sql: `SELECT s.id,s.slug,s.name,s.description,s.website,s.content,s.category_slug,
          s.logo_url,s.video_url,s.verification_attempts,s.badge_verified_at,s.created_at
        FROM listing_submissions s
        WHERE s.id IN (${pending})
        ORDER BY s.badge_verified_at,s.created_at`,
      params
    },
    {
      sql: `WITH pending AS (${pending})
        SELECT r.submission_id,r.label,r.url,r.sort_order
        FROM listing_submission_resource_links r
        JOIN pending ON pending.id=r.submission_id
        ORDER BY r.submission_id,r.sort_order`,
      params
    },
    {
      sql: `WITH pending AS (${pending})
        SELECT f.submission_id,f.question,f.answer,f.sort_order
        FROM listing_submission_faqs f
        JOIN pending ON pending.id=f.submission_id
        ORDER BY f.submission_id,f.sort_order`,
      params
    }
  ]
}

export function recordSubmissionNotificationPlan(input: {
  externalId: string
  externalUrl: string
  previewTokenHash: string
  recipient: string
  submissionId: string
}): SubmissionStatementPlan {
  return {
    sql: `INSERT INTO listing_submission_notifications
        (submission_id,channel,external_id,external_url,recipient,preview_token_hash)
      SELECT ?,?,?,?,?,? FROM listing_submissions
      WHERE id=? AND status='verified'
      ON CONFLICT(submission_id,channel) DO UPDATE SET
        external_id=excluded.external_id,
        external_url=excluded.external_url,
        recipient=excluded.recipient,
        preview_token_hash=excluded.preview_token_hash,
        updated_at=CURRENT_TIMESTAMP
      WHERE EXISTS (SELECT 1 FROM listing_submissions
        WHERE id=excluded.submission_id AND status='verified')`,
    params: [
      input.submissionId,
      CHANNEL,
      input.externalId,
      input.externalUrl,
      input.recipient,
      input.previewTokenHash,
      input.submissionId
    ]
  }
}
