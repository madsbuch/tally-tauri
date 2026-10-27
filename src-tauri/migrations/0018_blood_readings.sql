CREATE TABLE `blood_readings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`measured_at` text NOT NULL,
	`kind` text NOT NULL,
	`value` real NOT NULL,
	`note` text,
	`day` text NOT NULL,
	`tz_offset_min` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_blood_readings_day` ON `blood_readings` (`day`);--> statement-breakpoint
CREATE INDEX `idx_blood_readings_kind_measured_at` ON `blood_readings` (`kind`,`measured_at`);