DROP INDEX `custom_field_definitions_field_key_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `custom_field_definitions_entity_key_unique` ON `custom_field_definitions` (`entity_type`,`field_key`);--> statement-breakpoint
DELETE FROM `custom_field_values` WHERE `id` NOT IN (SELECT MAX(`id`) FROM `custom_field_values` GROUP BY `definition_id`,`entity_type`,`entity_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `custom_field_values_record_unique` ON `custom_field_values` (`definition_id`,`entity_type`,`entity_id`);--> statement-breakpoint
CREATE INDEX `custom_field_values_entity_idx` ON `custom_field_values` (`entity_type`,`entity_id`);
