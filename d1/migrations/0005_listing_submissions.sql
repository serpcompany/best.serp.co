PRAGMA foreign_keys = ON;

CREATE TABLE listing_submissions (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  website TEXT NOT NULL,
  content TEXT NOT NULL,
  category_slug TEXT NOT NULL,
  logo_url TEXT NOT NULL,
  video_url TEXT,
  status TEXT NOT NULL DEFAULT 'pending_badge'
    CHECK (status IN ('pending_badge', 'verified', 'approved', 'rejected')),
  access_token_hash TEXT NOT NULL,
  verification_attempts INTEGER NOT NULL DEFAULT 0 CHECK (verification_attempts >= 0),
  last_verification_at TEXT,
  last_verification_error TEXT,
  badge_verified_at TEXT,
  reviewed_at TEXT,
  reviewed_by TEXT,
  listing_id TEXT REFERENCES listings(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (site_id, access_token_hash)
) STRICT;

CREATE UNIQUE INDEX listing_submissions_active_slug_idx
  ON listing_submissions (site_id, slug)
  WHERE status IN ('pending_badge', 'verified');
CREATE INDEX listing_submissions_review_queue_idx
  ON listing_submissions (site_id, status, badge_verified_at, created_at);

CREATE TABLE listing_submission_resource_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id TEXT NOT NULL REFERENCES listing_submissions(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  url TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE (submission_id, sort_order)
) STRICT;

CREATE TABLE listing_submission_faqs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id TEXT NOT NULL REFERENCES listing_submissions(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE (submission_id, sort_order)
) STRICT;

CREATE TABLE listing_submission_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id TEXT NOT NULL REFERENCES listing_submissions(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (
    event_type IN ('created', 'verification_failed', 'badge_verified', 'approved', 'rejected')
  ),
  detail TEXT,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE INDEX listing_submission_events_submission_idx
  ON listing_submission_events (submission_id, created_at);
