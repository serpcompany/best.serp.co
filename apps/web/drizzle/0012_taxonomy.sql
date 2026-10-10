-- serpcompany/best.serp.co#341 (#343): the taxonomy's tables, STRICT like every table
-- (docs/data-model.md), and the Creator's suggested tags on submissions and revisions. The
-- triggers are in 0013_taxonomy_triggers.
CREATE TABLE `best_page_listings` (
	`best_page_id` integer NOT NULL,
	`listing_id` text NOT NULL,
	`position` integer,
	`excluded` integer DEFAULT false NOT NULL,
	`blurb` text,
	PRIMARY KEY(`best_page_id`, `listing_id`),
	FOREIGN KEY (`best_page_id`) REFERENCES `best_pages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`listing_id`) REFERENCES `listings`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "best_page_listings_excluded_boolean" CHECK("excluded" IN (0, 1)),
	CONSTRAINT "best_page_listings_pin_or_exclusion" CHECK(("best_page_listings"."excluded" = 0 AND "best_page_listings"."position" IS NOT NULL AND "best_page_listings"."position" >= 1)
        OR ("best_page_listings"."excluded" = 1 AND "best_page_listings"."position" IS NULL AND "best_page_listings"."blurb" IS NULL))
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `best_page_listings_position_idx` ON `best_page_listings` (`best_page_id`,`position`) WHERE "best_page_listings"."position" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `best_page_listings_listing_idx` ON `best_page_listings` (`listing_id`);--> statement-breakpoint
CREATE TABLE `best_pages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slug` text NOT NULL,
	`keyword` text NOT NULL,
	`title` text NOT NULL,
	`heading` text NOT NULL,
	`intro` text NOT NULL,
	`tag_id` integer,
	`category_id` integer,
	`list_size` integer DEFAULT 10 NOT NULL,
	`keyword_volume` integer,
	`keyword_checked_at` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "best_pages_list_size_range" CHECK("best_pages"."list_size" BETWEEN 5 AND 25),
	CONSTRAINT "best_pages_pool" CHECK("best_pages"."tag_id" IS NOT NULL OR "best_pages"."category_id" IS NOT NULL),
	CONSTRAINT "best_pages_is_active_boolean" CHECK("is_active" IN (0, 1)),
	CONSTRAINT "best_pages_keyword_checked_at_iso" CHECK("keyword_checked_at" IS strftime('%Y-%m-%dT%H:%M:%fZ', "keyword_checked_at"))
) STRICT;
--> statement-breakpoint
CREATE INDEX `best_pages_tag_idx` ON `best_pages` (`tag_id`);--> statement-breakpoint
CREATE INDEX `best_pages_category_idx` ON `best_pages` (`category_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `best_pages_slug_unique` ON `best_pages` (`slug`);--> statement-breakpoint
CREATE TABLE `listing_tags` (
	`listing_id` text NOT NULL,
	`tag_id` integer NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`listing_id`, `tag_id`),
	FOREIGN KEY (`listing_id`) REFERENCES `listings`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE restrict
) STRICT;
--> statement-breakpoint
CREATE INDEX `listing_tags_tag_idx` ON `listing_tags` (`tag_id`,`listing_id`);--> statement-breakpoint
CREATE TABLE `tags` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`category_id` integer NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "tags_is_active_boolean" CHECK("is_active" IN (0, 1))
) STRICT;
--> statement-breakpoint
CREATE INDEX `tags_category_idx` ON `tags` (`category_id`,`is_active`,`sort_order`,`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `tags_slug_unique` ON `tags` (`slug`);--> statement-breakpoint
CREATE TABLE `taxonomy_redirects` (
	`source_kind` text NOT NULL,
	`source_slug` text NOT NULL,
	`target_kind` text NOT NULL,
	`target_category_id` integer,
	`target_tag_id` integer,
	`target_best_page_id` integer,
	`manifest_id` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`source_kind`, `source_slug`),
	FOREIGN KEY (`target_category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`target_tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`target_best_page_id`) REFERENCES `best_pages`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "taxonomy_redirects_source_kind_valid" CHECK("taxonomy_redirects"."source_kind" IN ('category', 'tag', 'best')),
	CONSTRAINT "taxonomy_redirects_target_kind_valid" CHECK("taxonomy_redirects"."target_kind" IN ('category', 'tag', 'best', 'directory')),
	CONSTRAINT "taxonomy_redirects_target_matches_kind" CHECK(("taxonomy_redirects"."target_kind" = 'category' AND "taxonomy_redirects"."target_category_id" IS NOT NULL
          AND "taxonomy_redirects"."target_tag_id" IS NULL AND "taxonomy_redirects"."target_best_page_id" IS NULL)
        OR ("taxonomy_redirects"."target_kind" = 'tag' AND "taxonomy_redirects"."target_tag_id" IS NOT NULL
          AND "taxonomy_redirects"."target_category_id" IS NULL AND "taxonomy_redirects"."target_best_page_id" IS NULL)
        OR ("taxonomy_redirects"."target_kind" = 'best' AND "taxonomy_redirects"."target_best_page_id" IS NOT NULL
          AND "taxonomy_redirects"."target_category_id" IS NULL AND "taxonomy_redirects"."target_tag_id" IS NULL)
        OR ("taxonomy_redirects"."target_kind" = 'directory' AND "taxonomy_redirects"."target_category_id" IS NULL
          AND "taxonomy_redirects"."target_tag_id" IS NULL AND "taxonomy_redirects"."target_best_page_id" IS NULL))
) STRICT;
--> statement-breakpoint
CREATE INDEX `taxonomy_redirects_target_category_idx` ON `taxonomy_redirects` (`target_category_id`);--> statement-breakpoint
CREATE INDEX `taxonomy_redirects_target_tag_idx` ON `taxonomy_redirects` (`target_tag_id`);--> statement-breakpoint
CREATE INDEX `taxonomy_redirects_target_best_page_idx` ON `taxonomy_redirects` (`target_best_page_id`);--> statement-breakpoint
-- Hand-finished (docs/data-model.md): the intake tables only gain a nullable column. Drizzle
-- rebuilds a table to add a CHECK, and a rebuild of a referenced table cascades in D1.
ALTER TABLE `listing_submissions` ADD `tag_slugs` text CONSTRAINT "listing_submissions_tag_slugs_valid" CHECK("tag_slugs" IS NULL OR (json_valid("tag_slugs") AND json_type("tag_slugs") = 'array' AND json_array_length("tag_slugs") <= 3));--> statement-breakpoint
ALTER TABLE `listing_revisions` ADD `tag_slugs` text CONSTRAINT "listing_revisions_tag_slugs_valid" CHECK("tag_slugs" IS NULL OR (json_valid("tag_slugs") AND json_type("tag_slugs") = 'array' AND json_array_length("tag_slugs") <= 3));