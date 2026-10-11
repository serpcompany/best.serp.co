-- serpcompany/best.serp.co#406: a Creator may suggest a category on a submission or revision when
-- none fits, a short name and an optional note an admin reads at review. Hand-finished
-- (docs/data-model.md): the intake tables only gain nullable columns. Drizzle rebuilds a table to
-- add a CHECK, and a rebuild of a referenced table cascades in D1.
ALTER TABLE `listing_submissions` ADD `suggested_category` text CONSTRAINT "listing_submissions_suggested_category_valid" CHECK("suggested_category" IS NULL OR length("suggested_category") BETWEEN 1 AND 60);--> statement-breakpoint
ALTER TABLE `listing_submissions` ADD `suggested_category_note` text CONSTRAINT "listing_submissions_suggested_category_note_valid" CHECK("suggested_category_note" IS NULL OR ("suggested_category" IS NOT NULL AND length("suggested_category_note") BETWEEN 1 AND 300));--> statement-breakpoint
ALTER TABLE `listing_revisions` ADD `suggested_category` text CONSTRAINT "listing_revisions_suggested_category_valid" CHECK("suggested_category" IS NULL OR length("suggested_category") BETWEEN 1 AND 60);--> statement-breakpoint
ALTER TABLE `listing_revisions` ADD `suggested_category_note` text CONSTRAINT "listing_revisions_suggested_category_note_valid" CHECK("suggested_category_note" IS NULL OR ("suggested_category" IS NOT NULL AND length("suggested_category_note") BETWEEN 1 AND 300));
