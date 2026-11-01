CREATE TABLE `performance_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`measured_at` text NOT NULL,
	`title` text NOT NULL,
	`note` text,
	`photo_path` text,
	`model_id` text,
	`day` text NOT NULL,
	`tz_offset_min` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_performance_logs_day` ON `performance_logs` (`day`);--> statement-breakpoint
CREATE INDEX `idx_performance_logs_measured_at` ON `performance_logs` (`measured_at`);--> statement-breakpoint
CREATE TABLE `performance_stats` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`log_id` integer NOT NULL,
	`metric` text NOT NULL,
	`label` text NOT NULL,
	`value` real NOT NULL,
	`unit` text,
	FOREIGN KEY (`log_id`) REFERENCES `performance_logs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_performance_stats_log` ON `performance_stats` (`log_id`);--> statement-breakpoint
CREATE INDEX `idx_performance_stats_metric` ON `performance_stats` (`metric`);--> statement-breakpoint
ALTER TABLE `blood_readings` ADD `photo_path` text;