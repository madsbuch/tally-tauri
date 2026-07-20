ALTER TABLE `workouts` ADD `source` text;--> statement-breakpoint
ALTER TABLE `workouts` ADD `external_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_workouts_external_id` ON `workouts` (`external_id`);