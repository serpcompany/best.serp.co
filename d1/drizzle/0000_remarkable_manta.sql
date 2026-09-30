PRAGMA foreign_keys = ON;
--> statement-breakpoint
CREATE TABLE `categories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`site_id` text NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "categories_is_active_boolean" CHECK("is_active" IN (0, 1))
) STRICT;
--> statement-breakpoint
CREATE INDEX `categories_public_idx` ON `categories` (`site_id`,`is_active`,`sort_order`,`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `categories_site_slug_unique` ON `categories` (`site_id`,`slug`);--> statement-breakpoint
CREATE TABLE `listing_categories` (
	`listing_id` text NOT NULL,
	`category_id` integer NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`is_primary` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`listing_id`, `category_id`),
	FOREIGN KEY (`listing_id`) REFERENCES `listings`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "listing_categories_is_primary_boolean" CHECK("is_primary" IN (0, 1))
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `listing_categories_one_primary_idx` ON `listing_categories` (`listing_id`) WHERE "listing_categories"."is_primary" = 1;--> statement-breakpoint
CREATE INDEX `listing_categories_category_idx` ON `listing_categories` (`category_id`,`listing_id`);--> statement-breakpoint
CREATE INDEX `listing_categories_listing_order_idx` ON `listing_categories` (`listing_id`,`sort_order`);--> statement-breakpoint
CREATE TABLE `listing_faqs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`listing_id` text NOT NULL,
	`question` text NOT NULL,
	`answer` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`listing_id`) REFERENCES `listings`(`id`) ON UPDATE no action ON DELETE cascade
) STRICT;
--> statement-breakpoint
CREATE INDEX `listing_faqs_listing_idx` ON `listing_faqs` (`listing_id`,`sort_order`);--> statement-breakpoint
CREATE UNIQUE INDEX `listing_faqs_listing_order_unique` ON `listing_faqs` (`listing_id`,`sort_order`);--> statement-breakpoint
CREATE TABLE `listing_media` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`listing_id` text NOT NULL,
	`kind` text NOT NULL,
	`url` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`listing_id`) REFERENCES `listings`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "listing_media_kind_valid" CHECK("listing_media"."kind" IN ('logo', 'image', 'video'))
) STRICT;
--> statement-breakpoint
CREATE INDEX `listing_media_listing_idx` ON `listing_media` (`listing_id`,`sort_order`);--> statement-breakpoint
CREATE UNIQUE INDEX `listing_media_listing_kind_order_unique` ON `listing_media` (`listing_id`,`kind`,`sort_order`);--> statement-breakpoint
CREATE TABLE `listing_resource_links` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`listing_id` text NOT NULL,
	`label` text NOT NULL,
	`url` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`listing_id`) REFERENCES `listings`(`id`) ON UPDATE no action ON DELETE cascade
) STRICT;
--> statement-breakpoint
CREATE INDEX `listing_resource_links_listing_idx` ON `listing_resource_links` (`listing_id`,`sort_order`);--> statement-breakpoint
CREATE UNIQUE INDEX `listing_resource_links_listing_order_unique` ON `listing_resource_links` (`listing_id`,`sort_order`);--> statement-breakpoint
CREATE TABLE `listing_slug_redirects` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`site_id` text NOT NULL,
	`listing_id` text NOT NULL,
	`old_slug` text NOT NULL,
	`new_slug` text NOT NULL,
	`manifest_id` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`listing_id`) REFERENCES `listings`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "listing_slug_redirects_slug_change" CHECK("listing_slug_redirects"."old_slug" != "listing_slug_redirects"."new_slug")
) STRICT;
--> statement-breakpoint
CREATE INDEX `listing_slug_redirects_listing_idx` ON `listing_slug_redirects` (`listing_id`,"created_at" DESC);--> statement-breakpoint
CREATE UNIQUE INDEX `listing_slug_redirects_site_old_slug_unique` ON `listing_slug_redirects` (`site_id`,`old_slug`);--> statement-breakpoint
CREATE TABLE `listing_submission_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`submission_id` text NOT NULL,
	`event_type` text NOT NULL,
	`detail` text,
	`actor` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`submission_id`) REFERENCES `listing_submissions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "listing_submission_events_type_valid" CHECK("listing_submission_events"."event_type" IN ('created', 'verification_failed', 'badge_verified', 'approved', 'rejected'))
) STRICT;
--> statement-breakpoint
CREATE INDEX `listing_submission_events_submission_idx` ON `listing_submission_events` (`submission_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `listing_submission_faqs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`submission_id` text NOT NULL,
	`question` text NOT NULL,
	`answer` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`submission_id`) REFERENCES `listing_submissions`(`id`) ON UPDATE no action ON DELETE cascade
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `listing_submission_faqs_submission_order_unique` ON `listing_submission_faqs` (`submission_id`,`sort_order`);--> statement-breakpoint
CREATE TABLE `listing_submission_notifications` (
	`submission_id` text NOT NULL,
	`channel` text NOT NULL,
	`external_id` text NOT NULL,
	`external_url` text NOT NULL,
	`recipient` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`preview_token_hash` text,
	PRIMARY KEY(`submission_id`, `channel`),
	FOREIGN KEY (`submission_id`) REFERENCES `listing_submissions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "listing_submission_notifications_channel_valid" CHECK("listing_submission_notifications"."channel" IN ('github_issue'))
) STRICT;
--> statement-breakpoint
CREATE INDEX `listing_submission_notifications_recipient_idx` ON `listing_submission_notifications` (`channel`,`recipient`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `listing_submission_notifications_preview_token_idx` ON `listing_submission_notifications` (`preview_token_hash`) WHERE "listing_submission_notifications"."preview_token_hash" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `listing_submission_notifications_channel_external_unique` ON `listing_submission_notifications` (`channel`,`external_id`);--> statement-breakpoint
CREATE TABLE `listing_submission_rate_limits` (
	`fingerprint_hash` text PRIMARY KEY NOT NULL,
	`window_started_at` integer NOT NULL,
	`request_count` integer NOT NULL,
	CONSTRAINT "listing_submission_rate_limits_request_count_nonnegative" CHECK("listing_submission_rate_limits"."request_count" >= 0)
) STRICT;
--> statement-breakpoint
CREATE TABLE `listing_submission_resource_links` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`submission_id` text NOT NULL,
	`label` text NOT NULL,
	`url` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`submission_id`) REFERENCES `listing_submissions`(`id`) ON UPDATE no action ON DELETE cascade
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `listing_submission_resource_links_submission_order_unique` ON `listing_submission_resource_links` (`submission_id`,`sort_order`);--> statement-breakpoint
CREATE TABLE `listing_submissions` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`website` text NOT NULL,
	`content` text NOT NULL,
	`category_slug` text NOT NULL,
	`logo_url` text NOT NULL,
	`video_url` text,
	`status` text DEFAULT 'pending_badge' NOT NULL,
	`access_token_hash` text NOT NULL,
	`verification_attempts` integer DEFAULT 0 NOT NULL,
	`last_verification_at` text,
	`last_verification_error` text,
	`badge_verified_at` text,
	`reviewed_at` text,
	`reviewed_by` text,
	`listing_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`listing_id`) REFERENCES `listings`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "listing_submissions_status_valid" CHECK("listing_submissions"."status" IN ('pending_badge', 'verified', 'approved', 'rejected')),
	CONSTRAINT "listing_submissions_verification_attempts_nonnegative" CHECK("listing_submissions"."verification_attempts" >= 0)
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `listing_submissions_active_slug_idx` ON `listing_submissions` (`site_id`,`slug`) WHERE "listing_submissions"."status" IN ('pending_badge', 'verified');--> statement-breakpoint
CREATE INDEX `listing_submissions_review_queue_idx` ON `listing_submissions` (`site_id`,`status`,`badge_verified_at`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `listing_submissions_site_token_unique` ON `listing_submissions` (`site_id`,`access_token_hash`);--> statement-breakpoint
CREATE TABLE `listings` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`website` text NOT NULL,
	`content` text,
	`entity_type` text,
	`priority` text,
	`is_unofficial` integer DEFAULT false NOT NULL,
	`is_featured` integer DEFAULT false NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`published_at` text,
	`source_kind` text NOT NULL,
	`source_identity` text NOT NULL,
	`source_updated_at` text,
	`checksum` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`display_order` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "listings_priority_valid" CHECK("listings"."priority" IS NULL OR "listings"."priority" IN ('high', 'medium', 'low')),
	CONSTRAINT "listings_is_unofficial_boolean" CHECK("is_unofficial" IN (0, 1)),
	CONSTRAINT "listings_is_featured_boolean" CHECK("is_featured" IN (0, 1)),
	CONSTRAINT "listings_is_active_boolean" CHECK("is_active" IN (0, 1)),
	CONSTRAINT "listings_status_valid" CHECK("listings"."status" IN ('draft', 'review', 'approved', 'rejected')),
	CONSTRAINT "listings_display_order_nonnegative" CHECK("listings"."display_order" >= 0)
) STRICT;
--> statement-breakpoint
CREATE INDEX `listings_slug_lookup_idx` ON `listings` (`site_id`,`slug`);--> statement-breakpoint
CREATE INDEX `listings_publication_idx` ON `listings` (`site_id`,`status`,`is_active`,"published_at" DESC,`display_order`,`slug`);--> statement-breakpoint
CREATE INDEX `listings_featured_idx` ON `listings` (`site_id`,`status`,`is_active`,`is_featured`,"published_at" DESC,`display_order`);--> statement-breakpoint
CREATE INDEX `listings_name_idx` ON `listings` (`site_id`,"name" COLLATE NOCASE);--> statement-breakpoint
CREATE INDEX `listings_related_name_idx` ON `listings` (`site_id`,`name`,`slug`) WHERE "listings"."status" = 'approved' AND "listings"."is_active" = 1 AND "listings"."published_at" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `listings_site_slug_unique` ON `listings` (`site_id`,`slug`);--> statement-breakpoint
CREATE TABLE `migration_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`schema_version` integer NOT NULL,
	`manifest_identity` text NOT NULL,
	`input_checksum` text NOT NULL,
	`target_checksum` text NOT NULL,
	`affected_records` integer NOT NULL,
	`outcome` text NOT NULL,
	`error` text,
	`started_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "migration_runs_outcome_valid" CHECK("migration_runs"."outcome" IN ('started', 'succeeded', 'failed'))
) STRICT;
--> statement-breakpoint
CREATE INDEX `migration_runs_site_time_idx` ON `migration_runs` (`site_id`,"started_at" DESC);--> statement-breakpoint
CREATE UNIQUE INDEX `migration_runs_site_manifest_unique` ON `migration_runs` (`site_id`,`manifest_identity`);--> statement-breakpoint
CREATE TABLE `publication_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`manifest_id` text NOT NULL,
	`base_version` integer NOT NULL,
	`published_version` integer,
	`input_checksum` text NOT NULL,
	`affected_records` integer DEFAULT 0 NOT NULL,
	`affected_routes` text DEFAULT '' NOT NULL,
	`outcome` text NOT NULL,
	`error` text,
	`started_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`completed_at` text,
	`actor` text,
	`workflow` text,
	`before_checksum` text,
	`after_checksum` text,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "publication_runs_outcome_valid" CHECK("publication_runs"."outcome" IN ('started', 'succeeded', 'failed'))
) STRICT;
--> statement-breakpoint
CREATE INDEX `publication_runs_site_time_idx` ON `publication_runs` (`site_id`,"started_at" DESC);--> statement-breakpoint
CREATE UNIQUE INDEX `publication_runs_site_manifest_unique` ON `publication_runs` (`site_id`,`manifest_id`);--> statement-breakpoint
CREATE TABLE `publication_state` (
	`site_id` text PRIMARY KEY NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`manifest_id` text,
	`checksum` text NOT NULL,
	`published_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "publication_state_version_nonnegative" CHECK("publication_state"."version" >= 0)
) STRICT;
--> statement-breakpoint
CREATE TABLE `sites` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TRIGGER listing_categories_same_site_insert BEFORE INSERT ON listing_categories
WHEN (SELECT site_id FROM listings WHERE id = new.listing_id) !=
     (SELECT site_id FROM categories WHERE id = new.category_id)
BEGIN
  SELECT RAISE(ABORT, 'listing and category must belong to the same site');
END;
--> statement-breakpoint
CREATE TRIGGER listing_categories_same_site_update BEFORE UPDATE ON listing_categories
WHEN (SELECT site_id FROM listings WHERE id = new.listing_id) !=
     (SELECT site_id FROM categories WHERE id = new.category_id)
BEGIN
  SELECT RAISE(ABORT, 'listing and category must belong to the same site');
END;
--> statement-breakpoint
CREATE TRIGGER listings_require_primary_on_publication BEFORE UPDATE OF status, is_active, published_at ON listings
WHEN new.status = 'approved' AND new.is_active = 1 AND new.published_at IS NOT NULL
 AND (SELECT COUNT(*) FROM listing_categories WHERE listing_id = new.id AND is_primary = 1) != 1
BEGIN
  SELECT RAISE(ABORT, 'published listing must have exactly one primary category');
END;
--> statement-breakpoint
CREATE TRIGGER listings_require_primary_on_insert AFTER INSERT ON listings
WHEN new.status = 'approved' AND new.is_active = 1 AND new.published_at IS NOT NULL
 AND (SELECT COUNT(*) FROM listing_categories WHERE listing_id = new.id AND is_primary = 1) != 1
BEGIN
  SELECT RAISE(ABORT, 'published listing must have exactly one primary category');
END;
--> statement-breakpoint
CREATE TRIGGER listing_categories_prevent_primary_removal BEFORE DELETE ON listing_categories
WHEN old.is_primary = 1
 AND EXISTS (SELECT 1 FROM listings WHERE id = old.listing_id AND status = 'approved' AND is_active = 1 AND published_at IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'published listing must retain a primary category');
END;
--> statement-breakpoint
CREATE TRIGGER listing_categories_prevent_primary_demote BEFORE UPDATE OF is_primary ON listing_categories
WHEN old.is_primary = 1 AND new.is_primary = 0
 AND EXISTS (SELECT 1 FROM listings WHERE id = old.listing_id AND status = 'approved' AND is_active = 1 AND published_at IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'published listing must retain a primary category');
END;
