CREATE TABLE `progress_photos` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`taken_at` text NOT NULL,
	`day` text NOT NULL,
	`tz_offset_min` integer NOT NULL,
	`photo_path` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_progress_photos_taken_at` ON `progress_photos` (`taken_at`);