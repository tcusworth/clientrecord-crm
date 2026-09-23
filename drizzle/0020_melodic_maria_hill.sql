CREATE TABLE `customer_success_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` integer NOT NULL,
	`owner` text NOT NULL,
	`status` text DEFAULT 'Onboarding' NOT NULL,
	`onboarding_start` text,
	`onboarding_target` text,
	`health_score` integer DEFAULT 60 NOT NULL,
	`adoption_score` integer DEFAULT 0 NOT NULL,
	`renewal_date` text,
	`annual_value` integer DEFAULT 0 NOT NULL,
	`expansion_potential` text DEFAULT 'Unknown' NOT NULL,
	`churn_risk` text DEFAULT 'Low' NOT NULL,
	`objectives_json` text DEFAULT '[]' NOT NULL,
	`stakeholder_notes` text DEFAULT '' NOT NULL,
	`risks` text DEFAULT '' NOT NULL,
	`next_executive_touchpoint` text,
	`notes` text DEFAULT '' NOT NULL,
	`renewal_deal_id` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`renewal_deal_id`) REFERENCES `deals`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `customer_success_plans_company_id_unique` ON `customer_success_plans` (`company_id`);--> statement-breakpoint
CREATE INDEX `customer_success_status` ON `customer_success_plans` (`status`);--> statement-breakpoint
CREATE INDEX `customer_success_renewal` ON `customer_success_plans` (`renewal_date`);--> statement-breakpoint
CREATE INDEX `customer_success_company` ON `customer_success_plans` (`company_id`);--> statement-breakpoint
ALTER TABLE `inbox_messages` ADD `thread_key` text;--> statement-breakpoint
ALTER TABLE `inbox_messages` ADD `in_reply_to` text;--> statement-breakpoint
ALTER TABLE `inbox_messages` ADD `response_due_at` text;--> statement-breakpoint
ALTER TABLE `inbox_messages` ADD `first_response_at` text;--> statement-breakpoint
CREATE INDEX `inbox_messages_thread` ON `inbox_messages` (`thread_key`);--> statement-breakpoint
CREATE INDEX `inbox_messages_sla` ON `inbox_messages` (`direction`,`response_due_at`);