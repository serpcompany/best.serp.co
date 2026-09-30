PRAGMA foreign_keys = ON;

CREATE TABLE listing_submission_notifications (
  submission_id TEXT NOT NULL REFERENCES listing_submissions(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('github_issue')),
  external_id TEXT NOT NULL,
  external_url TEXT NOT NULL,
  recipient TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (submission_id, channel),
  UNIQUE (channel, external_id)
) STRICT;

CREATE INDEX listing_submission_notifications_recipient_idx
  ON listing_submission_notifications (channel, recipient, created_at);
