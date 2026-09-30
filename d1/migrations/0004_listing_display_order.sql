ALTER TABLE listings
  ADD COLUMN display_order INTEGER NOT NULL DEFAULT 0 CHECK (display_order >= 0);

DROP INDEX listings_publication_idx;
DROP INDEX listings_featured_idx;

CREATE INDEX listings_publication_idx
  ON listings (site_id, status, is_active, published_at DESC, display_order, slug);
CREATE INDEX listings_featured_idx
  ON listings (site_id, status, is_active, is_featured, published_at DESC, display_order);
