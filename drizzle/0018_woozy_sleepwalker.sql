ALTER TABLE `deal_proposals` ADD `body_markdown` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `deal_proposals` ADD `ai_artifact_id` text REFERENCES ai_artifacts(id);--> statement-breakpoint
ALTER TABLE `deal_proposals` ADD `source_summary` text DEFAULT '' NOT NULL;