CREATE TABLE `communication_review_items` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`source_id` text,
	`kind` text DEFAULT 'Unknown contact' NOT NULL,
	`status` text DEFAULT 'Pending' NOT NULL,
	`sender_email` text DEFAULT '' NOT NULL,
	`sender_name` text DEFAULT '' NOT NULL,
	`subject` text DEFAULT '' NOT NULL,
	`evidence_json` text DEFAULT '{}' NOT NULL,
	`suggested_contact_json` text DEFAULT '{}' NOT NULL,
	`company_candidates_json` text DEFAULT '[]' NOT NULL,
	`deal_candidates_json` text DEFAULT '[]' NOT NULL,
	`contact_id` integer REFERENCES `contacts`(`id`),
	`company_id` integer REFERENCES `companies`(`id`),
	`deal_id` integer REFERENCES `deals`(`id`),
	`confidence` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`reviewed_at` text,
	`reviewed_by` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `communication_review_source` ON `communication_review_items` (`source`,`source_id`,`kind`);--> statement-breakpoint
CREATE INDEX `communication_review_status_date` ON `communication_review_items` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `action_undo_log` (
	`id` text PRIMARY KEY NOT NULL,
	`action` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`before_json` text DEFAULT '{}' NOT NULL,
	`after_json` text DEFAULT '{}' NOT NULL,
	`actor` text NOT NULL,
	`expires_at` text NOT NULL,
	`undone_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `action_undo_actor_date` ON `action_undo_log` (`actor`,`created_at`);--> statement-breakpoint
CREATE INDEX `action_undo_expiry` ON `action_undo_log` (`expires_at`,`undone_at`);
