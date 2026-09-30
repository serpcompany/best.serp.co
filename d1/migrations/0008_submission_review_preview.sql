PRAGMA foreign_keys = ON;

ALTER TABLE listing_submission_notifications
  ADD COLUMN preview_token_hash TEXT;

CREATE UNIQUE INDEX listing_submission_notifications_preview_token_idx
  ON listing_submission_notifications (preview_token_hash)
  WHERE preview_token_hash IS NOT NULL;
