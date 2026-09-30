PRAGMA foreign_keys = ON;

CREATE TABLE listing_slug_redirects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  listing_id TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  old_slug TEXT NOT NULL,
  new_slug TEXT NOT NULL,
  manifest_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (site_id, old_slug),
  CHECK (old_slug != new_slug)
) STRICT;

CREATE INDEX listing_slug_redirects_listing_idx
  ON listing_slug_redirects (listing_id, created_at DESC);
