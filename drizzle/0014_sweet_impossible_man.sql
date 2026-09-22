CREATE TABLE `ai_record_fields` (
	`id` text PRIMARY KEY NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`field_key` text NOT NULL,
	`value_json` text NOT NULL,
	`explanation` text DEFAULT '' NOT NULL,
	`confidence` integer DEFAULT 0 NOT NULL,
	`citations_json` text DEFAULT '[]' NOT NULL,
	`source_artifact_id` text,
	`manual_override` integer DEFAULT false NOT NULL,
	`locked` integer DEFAULT false NOT NULL,
	`updated_by` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`source_artifact_id`) REFERENCES `ai_artifacts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_record_field_unique` ON `ai_record_fields` (`entity_type`,`entity_id`,`field_key`);--> statement-breakpoint
CREATE INDEX `ai_record_fields_entity` ON `ai_record_fields` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE INDEX `ai_record_fields_artifact` ON `ai_record_fields` (`source_artifact_id`);