CREATE TABLE `account_signals` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` integer NOT NULL,
	`kind` text NOT NULL,
	`summary` text NOT NULL,
	`evidence` text NOT NULL,
	`points` integer NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`occurred_at` text NOT NULL,
	`created_at` text NOT NULL,
	`actor` text NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `signals_company_active` ON `account_signals` (`company_id`,`active`);--> statement-breakpoint
CREATE TABLE `account_stakeholders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`company_id` integer NOT NULL,
	`contact_id` integer NOT NULL,
	`role` text NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stakeholder_account_contact` ON `account_stakeholders` (`company_id`,`contact_id`);--> statement-breakpoint
CREATE TABLE `deal_stage_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`deal_id` integer NOT NULL,
	`from_stage` text NOT NULL,
	`to_stage` text NOT NULL,
	`from_pipeline` text NOT NULL,
	`to_pipeline` text NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`actor` text NOT NULL,
	`happened_at` text NOT NULL,
	FOREIGN KEY (`deal_id`) REFERENCES `deals`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `history_deal_date` ON `deal_stage_history` (`deal_id`,`happened_at`);--> statement-breakpoint
CREATE TABLE `deal_tasks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`deal_id` integer NOT NULL,
	`title` text NOT NULL,
	`owner` text NOT NULL,
	`due_date` text NOT NULL,
	`completed` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`deal_id`) REFERENCES `deals`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `deal_tasks_deal_due` ON `deal_tasks` (`deal_id`,`due_date`);--> statement-breakpoint
CREATE TABLE `qualification_alerts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`company_id` integer NOT NULL,
	`owner` text NOT NULL,
	`message` text NOT NULL,
	`created_at` text NOT NULL,
	`read_at` text,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `alerts_owner_read` ON `qualification_alerts` (`owner`,`read_at`);--> statement-breakpoint
CREATE TABLE `sales_pipelines` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`stages` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `companies` ADD `website` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `companies` ADD `industry` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `companies` ADD `tier` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `companies` ADD `territory` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `companies` ADD `owner` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `companies` ADD `tags` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `companies` ADD `fit_score` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `companies` ADD `fit_reason` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `companies` ADD `intent_score` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `companies` ADD `temperature` text DEFAULT 'Cold' NOT NULL;--> statement-breakpoint
ALTER TABLE `deals` ADD `pipeline_key` text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE `deals` ADD `stage_key` text;--> statement-breakpoint
ALTER TABLE `deals` ADD `closed_reason` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `deals` ADD `stage_entered_at` text DEFAULT '' NOT NULL;