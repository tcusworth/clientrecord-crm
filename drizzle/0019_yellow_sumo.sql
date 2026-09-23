CREATE TABLE `inbox_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text DEFAULT 'Manual' NOT NULL,
	`external_id` text,
	`direction` text DEFAULT 'Inbound' NOT NULL,
	`from_email` text NOT NULL,
	`from_name` text DEFAULT '' NOT NULL,
	`to_emails` text DEFAULT '[]' NOT NULL,
	`subject` text DEFAULT '' NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`attachments_json` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'Unassigned' NOT NULL,
	`owner` text DEFAULT '' NOT NULL,
	`contact_id` integer,
	`company_id` integer,
	`deal_id` integer,
	`task_id` integer,
	`occurred_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`deal_id`) REFERENCES `deals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inbox_messages_provider_external` ON `inbox_messages` (`provider`,`external_id`);--> statement-breakpoint
CREATE INDEX `inbox_messages_status_date` ON `inbox_messages` (`status`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `inbox_messages_contact` ON `inbox_messages` (`contact_id`);--> statement-breakpoint
CREATE TABLE `lead_intakes` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text DEFAULT 'Website' NOT NULL,
	`form_name` text DEFAULT '' NOT NULL,
	`first_name` text DEFAULT '' NOT NULL,
	`last_name` text DEFAULT '' NOT NULL,
	`email` text NOT NULL,
	`company_name` text DEFAULT '' NOT NULL,
	`website` text DEFAULT '' NOT NULL,
	`message` text DEFAULT '' NOT NULL,
	`attribution_json` text DEFAULT '{}' NOT NULL,
	`payload_json` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'New' NOT NULL,
	`owner` text DEFAULT '' NOT NULL,
	`contact_id` integer,
	`company_id` integer,
	`duplicate_contact_id` integer,
	`task_id` integer,
	`received_at` text NOT NULL,
	`routed_at` text,
	`resolved_at` text,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`duplicate_contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `lead_intakes_status_received` ON `lead_intakes` (`status`,`received_at`);--> statement-breakpoint
CREATE INDEX `lead_intakes_email` ON `lead_intakes` (`email`);--> statement-breakpoint
ALTER TABLE `deal_proposals` ADD `sent_at` text;--> statement-breakpoint
ALTER TABLE `deal_proposals` ADD `opened_at` text;--> statement-breakpoint
ALTER TABLE `deal_proposals` ADD `accepted_at` text;--> statement-breakpoint
ALTER TABLE `deal_proposals` ADD `accepted_by` text;