CREATE TABLE `campaign_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`campaign_id` integer NOT NULL,
	`provider_event_id` text NOT NULL,
	`type` text NOT NULL,
	`email_id` text,
	`recipient` text,
	`occurred_at` text NOT NULL,
	`payload` text NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `campaign_events_provider_event_id_unique` ON `campaign_events` (`provider_event_id`);--> statement-breakpoint
ALTER TABLE `campaigns` ADD `preview_text` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `html` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `text_body` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `resend_segment_id` text;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `resend_broadcast_id` text;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `scheduled_at` text;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `sent_at` text;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `delivered_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `opened_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `clicked_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `bounced_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `complained_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `updated_at` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `contacts` ADD `resend_id` text;--> statement-breakpoint
ALTER TABLE `contacts` ADD `resend_synced_at` text;