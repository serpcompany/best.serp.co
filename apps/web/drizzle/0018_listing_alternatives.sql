-- serpcompany/best.serp.co#519: a listing's hand-picked alternatives, in order, which its page's
-- Alternatives section shows first. Written by reviewed manifests (`listing-alternatives-set`).
-- Hand-finished (docs/data-model.md): the table is STRICT.
CREATE TABLE `listing_alternatives` (
	`listing_id` text NOT NULL,
	`alternative_id` text NOT NULL,
	`position` integer NOT NULL,
	PRIMARY KEY(`listing_id`, `alternative_id`),
	FOREIGN KEY (`listing_id`) REFERENCES `listings`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`alternative_id`) REFERENCES `listings`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "listing_alternatives_not_self" CHECK("listing_alternatives"."alternative_id" != "listing_alternatives"."listing_id"),
	CONSTRAINT "listing_alternatives_position_positive" CHECK("listing_alternatives"."position" >= 1)
) STRICT;
--> statement-breakpoint
CREATE INDEX `listing_alternatives_alternative_idx` ON `listing_alternatives` (`alternative_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `listing_alternatives_listing_position_unique` ON `listing_alternatives` (`listing_id`,`position`);