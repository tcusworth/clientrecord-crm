CREATE TABLE `meetily_webhook_events` (
	`id` text PRIMARY KEY NOT NULL,
	`external_id` text NOT NULL,
	`event_type` text DEFAULT 'meeting.completed' NOT NULL,
	`payload_json` text NOT NULL,
	`payload_hash` text NOT NULL,
	`subject` text DEFAULT 'Meetily meeting' NOT NULL,
	`occurred_at` text NOT NULL,
	`status` text DEFAULT 'Needs association' NOT NULL,
	`deal_id` integer,
	`meeting_id` text,
	`error` text DEFAULT '' NOT NULL,
	`duplicate_count` integer DEFAULT 0 NOT NULL,
	`received_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`processed_at` text,
	FOREIGN KEY (`deal_id`) REFERENCES `deals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`meeting_id`) REFERENCES `deal_meetings`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `meetily_webhook_events_external_id_unique` ON `meetily_webhook_events` (`external_id`);--> statement-breakpoint
CREATE INDEX `meetily_events_status_date` ON `meetily_webhook_events` (`status`,`received_at`);--> statement-breakpoint
CREATE INDEX `meetily_events_deal` ON `meetily_webhook_events` (`deal_id`);