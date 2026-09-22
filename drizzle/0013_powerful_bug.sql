CREATE TABLE `deal_meeting_attendees` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`meeting_id` text NOT NULL,
	`contact_id` integer,
	`name` text DEFAULT '' NOT NULL,
	`email` text DEFAULT '' NOT NULL,
	`role` text DEFAULT 'Attendee' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`meeting_id`) REFERENCES `deal_meetings`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `deal_meeting_attendees_meeting` ON `deal_meeting_attendees` (`meeting_id`);--> statement-breakpoint
CREATE INDEX `deal_meeting_attendees_contact` ON `deal_meeting_attendees` (`contact_id`);--> statement-breakpoint
CREATE TABLE `deal_meetings` (
	`id` text PRIMARY KEY NOT NULL,
	`deal_id` integer NOT NULL,
	`company_id` integer,
	`activity_id` integer,
	`subject` text NOT NULL,
	`status` text DEFAULT 'Scheduled' NOT NULL,
	`starts_at` text NOT NULL,
	`ends_at` text,
	`owner` text NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`decisions_json` text DEFAULT '[]' NOT NULL,
	`customer_commitments_json` text DEFAULT '[]' NOT NULL,
	`internal_commitments_json` text DEFAULT '[]' NOT NULL,
	`risks_objections_json` text DEFAULT '[]' NOT NULL,
	`next_steps_json` text DEFAULT '[]' NOT NULL,
	`transcript_document_id` text,
	`source_provider` text DEFAULT 'Manual' NOT NULL,
	`external_id` text,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`deal_id`) REFERENCES `deals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`activity_id`) REFERENCES `deal_activities`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`transcript_document_id`) REFERENCES `client_documents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `deal_meetings_deal_start` ON `deal_meetings` (`deal_id`,`starts_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `deal_meetings_provider_external` ON `deal_meetings` (`source_provider`,`external_id`);--> statement-breakpoint
CREATE INDEX `deal_meetings_activity` ON `deal_meetings` (`activity_id`);--> statement-breakpoint
PRAGMA optimize;
