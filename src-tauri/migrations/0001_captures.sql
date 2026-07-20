CREATE TABLE `captures` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`created_at` text NOT NULL,
	`day` text NOT NULL,
	`note` text,
	`photo_path` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `idx_captures_day` ON `captures` (`day`);