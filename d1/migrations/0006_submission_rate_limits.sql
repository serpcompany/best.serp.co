CREATE TABLE listing_submission_rate_limits (
  fingerprint_hash TEXT PRIMARY KEY,
  window_started_at INTEGER NOT NULL,
  request_count INTEGER NOT NULL CHECK (request_count >= 0)
) STRICT;
