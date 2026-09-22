CREATE TABLE `deal_recommendations` (
	`id` text PRIMARY KEY NOT NULL,
	`deal_id` integer NOT NULL,
	`rule_key` text NOT NULL,
	`fingerprint` text NOT NULL,
	`action` text NOT NULL,
	`reason` text NOT NULL,
	`evidence_json` text NOT NULL,
	`priority` text NOT NULL,
	`suggested_owner` text NOT NULL,
	`suggested_due_date` text NOT NULL,
	`status` text DEFAULT 'Active' NOT NULL,
	`current_key` text,
	`task_id` integer,
	`generated_at` text NOT NULL,
	`accepted_at` text,
	`dismissed_at` text,
	`completed_at` text,
	`decided_by` text,
	`decision_note` text DEFAULT '' NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`deal_id`) REFERENCES `deals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `deal_tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `deal_recommendation_fingerprint` ON `deal_recommendations` (`deal_id`,`fingerprint`);--> statement-breakpoint
CREATE UNIQUE INDEX `deal_recommendation_current` ON `deal_recommendations` (`deal_id`,`current_key`);--> statement-breakpoint
CREATE INDEX `deal_recommendations_deal_date` ON `deal_recommendations` (`deal_id`,`generated_at`);