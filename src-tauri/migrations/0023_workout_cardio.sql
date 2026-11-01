ALTER TABLE `workouts` ADD `cardio` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Workouts already switched on as Zone 2 start out as cardio.
UPDATE `workouts` SET `cardio` = 1 WHERE `zone2_min` > 0;
