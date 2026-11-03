CREATE TABLE `saved_meals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`nutrients` text DEFAULT '{}' NOT NULL,
	`icon` text,
	`source_entry_id` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_saved_meals_name` ON `saved_meals` (`name`);