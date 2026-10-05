CREATE TABLE `email_deliveries` (
	`event_key` text PRIMARY KEY NOT NULL,
	`template_id` text NOT NULL,
	`provider` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 1 NOT NULL,
	`provider_message_id` text,
	`last_error_code` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "email_deliveries_event_key_valid" CHECK(length("email_deliveries"."event_key") BETWEEN 3 AND 200 AND instr("email_deliveries"."event_key", '@') = 0),
	CONSTRAINT "email_deliveries_status_valid" CHECK("email_deliveries"."status" IN ('sending', 'sent', 'failed')),
	CONSTRAINT "email_deliveries_attempts_positive" CHECK("email_deliveries"."attempts" >= 1)
) STRICT;
