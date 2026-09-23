CREATE TABLE `quickbooks_invoices` (
	`id` text PRIMARY KEY NOT NULL,
	`proposal_id` integer NOT NULL,
	`deal_id` integer NOT NULL,
	`company_id` integer,
	`quickbooks_customer_id` text DEFAULT '' NOT NULL,
	`quickbooks_invoice_id` text DEFAULT '' NOT NULL,
	`document_number` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'Draft' NOT NULL,
	`amount` integer DEFAULT 0 NOT NULL,
	`balance` integer DEFAULT 0 NOT NULL,
	`due_date` text,
	`synced_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`proposal_id`) REFERENCES `deal_proposals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`deal_id`) REFERENCES `deals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `quickbooks_invoices_proposal` ON `quickbooks_invoices` (`proposal_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `quickbooks_invoices_external` ON `quickbooks_invoices` (`quickbooks_invoice_id`);--> statement-breakpoint
CREATE INDEX `quickbooks_invoices_status_due` ON `quickbooks_invoices` (`status`,`due_date`);--> statement-breakpoint
CREATE INDEX `quickbooks_invoices_deal` ON `quickbooks_invoices` (`deal_id`);--> statement-breakpoint
ALTER TABLE `integration_accounts` ADD `metadata_json` text DEFAULT '{}' NOT NULL;