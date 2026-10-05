DROP INDEX `listing_faqs_listing_idx`;--> statement-breakpoint
DROP INDEX `listing_media_listing_idx`;--> statement-breakpoint
DROP INDEX `listing_resource_links_listing_idx`;--> statement-breakpoint
DROP INDEX `listings_name_idx`;--> statement-breakpoint
CREATE INDEX `listings_display_order_idx` ON `listings` (`display_order`);--> statement-breakpoint
CREATE INDEX `listings_website_lookup_idx` ON `listings` (`website`);--> statement-breakpoint
DROP INDEX `listing_owners_user_idx`;--> statement-breakpoint
CREATE INDEX `listing_owners_listing_idx` ON `listing_owners` (`listing_id`);--> statement-breakpoint
CREATE INDEX `listing_owners_user_idx` ON `listing_owners` (`user_id`,`listing_id`);--> statement-breakpoint
CREATE INDEX `listing_revisions_listing_idx` ON `listing_revisions` (`listing_id`);--> statement-breakpoint
CREATE INDEX `listing_submission_url_blocks_submission_idx` ON `listing_submission_url_blocks` (`submission_id`);