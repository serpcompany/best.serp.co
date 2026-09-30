PRAGMA foreign_keys = ON;

CREATE TABLE sites (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE TABLE categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (site_id, slug)
) STRICT;

CREATE TABLE listings (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  website TEXT NOT NULL,
  content TEXT,
  entity_type TEXT,
  priority TEXT CHECK (priority IS NULL OR priority IN ('high', 'medium', 'low')),
  is_unofficial INTEGER NOT NULL DEFAULT 0 CHECK (is_unofficial IN (0, 1)),
  is_featured INTEGER NOT NULL DEFAULT 0 CHECK (is_featured IN (0, 1)),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'review', 'approved', 'rejected')),
  published_at TEXT,
  source_kind TEXT NOT NULL,
  source_identity TEXT NOT NULL,
  source_updated_at TEXT,
  checksum TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (site_id, slug)
) STRICT;

CREATE TABLE listing_categories (
  listing_id TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  PRIMARY KEY (listing_id, category_id)
) STRICT;

CREATE UNIQUE INDEX listing_categories_one_primary_idx
  ON listing_categories (listing_id) WHERE is_primary = 1;

CREATE TABLE listing_media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('logo', 'image', 'video')),
  url TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE (listing_id, kind, sort_order)
) STRICT;

CREATE TABLE listing_resource_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  url TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE (listing_id, sort_order)
) STRICT;

CREATE TABLE listing_faqs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE (listing_id, sort_order)
) STRICT;

CREATE TABLE publication_state (
  site_id TEXT PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  manifest_id TEXT,
  checksum TEXT NOT NULL,
  published_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE TABLE migration_runs (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  schema_version INTEGER NOT NULL,
  manifest_identity TEXT NOT NULL,
  input_checksum TEXT NOT NULL,
  target_checksum TEXT NOT NULL,
  affected_records INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('started', 'succeeded', 'failed')),
  error TEXT,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  UNIQUE (site_id, manifest_identity)
) STRICT;

CREATE TABLE publication_runs (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  manifest_id TEXT NOT NULL,
  base_version INTEGER NOT NULL,
  published_version INTEGER,
  input_checksum TEXT NOT NULL,
  affected_records INTEGER NOT NULL DEFAULT 0,
  affected_routes TEXT NOT NULL DEFAULT '',
  outcome TEXT NOT NULL CHECK (outcome IN ('started', 'succeeded', 'failed')),
  error TEXT,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  UNIQUE (site_id, manifest_id)
) STRICT;

CREATE INDEX listings_slug_lookup_idx ON listings (site_id, slug);
CREATE INDEX listings_publication_idx
  ON listings (site_id, status, is_active, published_at DESC, slug);
CREATE INDEX listings_featured_idx
  ON listings (site_id, status, is_active, is_featured, published_at DESC);
CREATE INDEX listings_name_idx ON listings (site_id, name COLLATE NOCASE);
CREATE INDEX listing_categories_category_idx ON listing_categories (category_id, listing_id);
CREATE INDEX listing_categories_listing_order_idx ON listing_categories (listing_id, sort_order);
CREATE INDEX listing_media_listing_idx ON listing_media (listing_id, sort_order);
CREATE INDEX listing_resource_links_listing_idx ON listing_resource_links (listing_id, sort_order);
CREATE INDEX listing_faqs_listing_idx ON listing_faqs (listing_id, sort_order);
CREATE INDEX categories_public_idx ON categories (site_id, is_active, sort_order, name);
CREATE INDEX migration_runs_site_time_idx ON migration_runs (site_id, started_at DESC);
CREATE INDEX publication_runs_site_time_idx ON publication_runs (site_id, started_at DESC);

CREATE TRIGGER listing_categories_same_site_insert BEFORE INSERT ON listing_categories
WHEN (SELECT site_id FROM listings WHERE id = new.listing_id) !=
     (SELECT site_id FROM categories WHERE id = new.category_id)
BEGIN
  SELECT RAISE(ABORT, 'listing and category must belong to the same site');
END;

CREATE TRIGGER listing_categories_same_site_update BEFORE UPDATE ON listing_categories
WHEN (SELECT site_id FROM listings WHERE id = new.listing_id) !=
     (SELECT site_id FROM categories WHERE id = new.category_id)
BEGIN
  SELECT RAISE(ABORT, 'listing and category must belong to the same site');
END;

CREATE TRIGGER listings_require_primary_on_publication BEFORE UPDATE OF status, is_active, published_at ON listings
WHEN new.status = 'approved' AND new.is_active = 1 AND new.published_at IS NOT NULL
 AND (SELECT COUNT(*) FROM listing_categories WHERE listing_id = new.id AND is_primary = 1) != 1
BEGIN
  SELECT RAISE(ABORT, 'published listing must have exactly one primary category');
END;

CREATE TRIGGER listings_require_primary_on_insert AFTER INSERT ON listings
WHEN new.status = 'approved' AND new.is_active = 1 AND new.published_at IS NOT NULL
 AND (SELECT COUNT(*) FROM listing_categories WHERE listing_id = new.id AND is_primary = 1) != 1
BEGIN
  SELECT RAISE(ABORT, 'published listing must have exactly one primary category');
END;

CREATE TRIGGER listing_categories_prevent_primary_removal BEFORE DELETE ON listing_categories
WHEN old.is_primary = 1
 AND EXISTS (SELECT 1 FROM listings WHERE id = old.listing_id AND status = 'approved' AND is_active = 1 AND published_at IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'published listing must retain a primary category');
END;

CREATE TRIGGER listing_categories_prevent_primary_demote BEFORE UPDATE OF is_primary ON listing_categories
WHEN old.is_primary = 1 AND new.is_primary = 0
 AND EXISTS (SELECT 1 FROM listings WHERE id = old.listing_id AND status = 'approved' AND is_active = 1 AND published_at IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'published listing must retain a primary category');
END;
