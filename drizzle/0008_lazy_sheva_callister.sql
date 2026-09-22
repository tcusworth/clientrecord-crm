CREATE TABLE `client_documents` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` integer,
	`contact_id` integer,
	`deal_id` integer,
	`title` text NOT NULL,
	`category` text DEFAULT 'Correspondence' NOT NULL,
	`status` text DEFAULT 'Active' NOT NULL,
	`sensitive` integer DEFAULT false NOT NULL,
	`latest_version` integer DEFAULT 1 NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`archived_at` text,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`deal_id`) REFERENCES `deals`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `client_documents_deal_status` ON `client_documents` (`deal_id`,`status`);--> statement-breakpoint
CREATE INDEX `client_documents_company_status` ON `client_documents` (`company_id`,`status`);--> statement-breakpoint
CREATE INDEX `client_documents_contact_status` ON `client_documents` (`contact_id`,`status`);--> statement-breakpoint
CREATE TABLE `deal_activities` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`deal_id` integer NOT NULL,
	`company_id` integer,
	`contact_id` integer,
	`type` text NOT NULL,
	`subject` text DEFAULT '' NOT NULL,
	`body` text NOT NULL,
	`owner` text NOT NULL,
	`outcome` text DEFAULT '' NOT NULL,
	`happened_at` text NOT NULL,
	`follow_up_at` text,
	`source` text DEFAULT 'Manual' NOT NULL,
	`thread_key` text,
	`external_id` text,
	`pinned` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`deal_id`) REFERENCES `deals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `deal_activities_deal_date` ON `deal_activities` (`deal_id`,`happened_at`);--> statement-breakpoint
CREATE INDEX `deal_activities_contact_date` ON `deal_activities` (`contact_id`,`happened_at`);--> statement-breakpoint
CREATE INDEX `deal_activities_thread` ON `deal_activities` (`thread_key`);--> statement-breakpoint
CREATE TABLE `deal_insights` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`deal_id` integer NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`detail` text DEFAULT '' NOT NULL,
	`severity` text DEFAULT 'Medium' NOT NULL,
	`status` text DEFAULT 'Open' NOT NULL,
	`owner` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`deal_id`) REFERENCES `deals`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `deal_insights_deal_kind` ON `deal_insights` (`deal_id`,`kind`);--> statement-breakpoint
CREATE TABLE `deal_line_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`deal_id` integer NOT NULL,
	`name` text NOT NULL,
	`sku` text DEFAULT '' NOT NULL,
	`quantity` integer DEFAULT 1 NOT NULL,
	`unit_price` integer DEFAULT 0 NOT NULL,
	`discount_percent` integer DEFAULT 0 NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`deal_id`) REFERENCES `deals`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `deal_line_items_deal` ON `deal_line_items` (`deal_id`);--> statement-breakpoint
CREATE TABLE `deal_notes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`deal_id` integer NOT NULL,
	`kind` text DEFAULT 'Note' NOT NULL,
	`body` text NOT NULL,
	`owner` text NOT NULL,
	`pinned` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`deal_id`) REFERENCES `deals`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `deal_notes_deal_pinned` ON `deal_notes` (`deal_id`,`pinned`,`created_at`);--> statement-breakpoint
CREATE TABLE `deal_proposals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`deal_id` integer NOT NULL,
	`title` text NOT NULL,
	`amount` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'Draft' NOT NULL,
	`valid_until` text,
	`document_id` text,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`deal_id`) REFERENCES `deals`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `deal_proposals_deal` ON `deal_proposals` (`deal_id`);--> statement-breakpoint
CREATE TABLE `deal_reviews` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`deal_id` integer NOT NULL,
	`review_type` text DEFAULT 'Deal review' NOT NULL,
	`status` text DEFAULT 'Requested' NOT NULL,
	`approver` text NOT NULL,
	`requested_by` text NOT NULL,
	`comments` text DEFAULT '' NOT NULL,
	`requested_at` text NOT NULL,
	`decided_at` text,
	FOREIGN KEY (`deal_id`) REFERENCES `deals`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `deal_reviews_deal_status` ON `deal_reviews` (`deal_id`,`status`);--> statement-breakpoint
CREATE TABLE `deal_stakeholders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`deal_id` integer NOT NULL,
	`contact_id` integer NOT NULL,
	`role` text NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`is_primary` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`deal_id`) REFERENCES `deals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `deal_stakeholder_unique` ON `deal_stakeholders` (`deal_id`,`contact_id`);--> statement-breakpoint
CREATE INDEX `deal_stakeholders_contact` ON `deal_stakeholders` (`contact_id`);--> statement-breakpoint
CREATE TABLE `document_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`version` integer NOT NULL,
	`object_key` text NOT NULL,
	`filename` text NOT NULL,
	`content_type` text NOT NULL,
	`size` integer NOT NULL,
	`checksum` text NOT NULL,
	`uploaded_by` text NOT NULL,
	`uploaded_at` text NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `client_documents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `document_versions_object_key_unique` ON `document_versions` (`object_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `document_versions_document_version` ON `document_versions` (`document_id`,`version`);--> statement-breakpoint
CREATE INDEX `document_versions_document` ON `document_versions` (`document_id`);--> statement-breakpoint
ALTER TABLE `companies` ADD `domain` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `deals` ADD `company_id` integer REFERENCES companies(id);--> statement-breakpoint
ALTER TABLE `sync_records` ADD `deal_id` integer REFERENCES deals(id);--> statement-breakpoint
ALTER TABLE `sync_records` ADD `thread_key` text;