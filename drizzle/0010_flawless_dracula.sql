CREATE TABLE `deal_relationship_health_scores` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`deal_id` integer NOT NULL,
	`score` integer NOT NULL,
	`band` text NOT NULL,
	`provisional` integer DEFAULT true NOT NULL,
	`confidence` text NOT NULL,
	`confidence_score` integer NOT NULL,
	`components_json` text NOT NULL,
	`evidence_json` text NOT NULL,
	`data_gaps_json` text NOT NULL,
	`input_hash` text NOT NULL,
	`calculated_at` text NOT NULL,
	FOREIGN KEY (`deal_id`) REFERENCES `deals`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `deal_relationship_health_input` ON `deal_relationship_health_scores` (`deal_id`,`input_hash`);--> statement-breakpoint
CREATE INDEX `deal_relationship_health_deal_date` ON `deal_relationship_health_scores` (`deal_id`,`calculated_at`);--> statement-breakpoint
ALTER TABLE `deal_activities` ADD `response_expected` integer DEFAULT false NOT NULL;