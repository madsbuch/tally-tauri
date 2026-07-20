CREATE TABLE `fasts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`started_at` text NOT NULL,
	`goal_hours` real NOT NULL,
	`ended_at` text
);
--> statement-breakpoint
CREATE TABLE `food_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`eaten_at` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`photo_path` text,
	`nutrients` text DEFAULT '{}' NOT NULL,
	`model_id` text
);
--> statement-breakpoint
CREATE INDEX `idx_food_entries_eaten_at` ON `food_entries` (`eaten_at`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `supplement_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`supplement_id` integer NOT NULL,
	`taken_at` text NOT NULL,
	`amount` real DEFAULT 1 NOT NULL,
	FOREIGN KEY (`supplement_id`) REFERENCES `supplements`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_supplement_logs_taken_at` ON `supplement_logs` (`taken_at`);--> statement-breakpoint
CREATE TABLE `supplements` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`dose_amount` real,
	`dose_unit` text,
	`nutrients` text DEFAULT '{}' NOT NULL,
	`notes` text,
	`archived` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `workouts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`performed_at` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`photo_path` text,
	`calories_burned` real DEFAULT 0 NOT NULL,
	`duration_min` real,
	`model_id` text
);
--> statement-breakpoint
CREATE INDEX `idx_workouts_performed_at` ON `workouts` (`performed_at`);