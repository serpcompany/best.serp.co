-- Preserve deterministic related-listing name/slug ranking without sorting every
-- eligible candidate. The partial predicate keeps draft, inactive, and unpublished
-- rows out of the index while retaining future approved rows for time-based
-- eligibility checks.
CREATE INDEX listings_related_name_idx
ON listings (site_id, name, slug)
WHERE status = 'approved' AND is_active = 1 AND published_at IS NOT NULL;
