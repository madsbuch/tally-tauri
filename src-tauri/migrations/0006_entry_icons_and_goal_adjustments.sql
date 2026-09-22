CREATE TABLE `day_goal_adjustments` (
	`day` text PRIMARY KEY NOT NULL,
	`delta_kcal` real NOT NULL,
	`note` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `food_entries` ADD `icon` text;--> statement-breakpoint
ALTER TABLE `workouts` ADD `icon` text;