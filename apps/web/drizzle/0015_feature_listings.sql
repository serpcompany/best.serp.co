-- serpcompany/best.serp.co#409: a listing that names one feature of a larger site (#349's
-- `featureListings`), which a best page never pins, is recorded in D1 instead of in app code.
-- Hand-finished (docs/data-model.md): `listings` only gains columns. Drizzle rebuilds the table to
-- add a CHECK, and a rebuild of `listings` would cascade-delete its memberships, media, links, and
-- FAQs and drop the primary-category triggers.
ALTER TABLE `listings` ADD `is_feature_listing` integer DEFAULT false NOT NULL CONSTRAINT "listings_is_feature_listing_boolean" CHECK("is_feature_listing" IN (0, 1));
