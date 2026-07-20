CREATE TABLE `health_metrics` (
	`day` text PRIMARY KEY NOT NULL,
	`steps` integer,
	`resting_hr` real,
	`hrv_ms` real,
	`spo2_pct` real,
	`weight_kg` real,
	`vo2_max` real,
	`calories_total` real,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sleep_sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`external_id` text NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text NOT NULL,
	`duration_min` real NOT NULL,
	`deep_min` real,
	`rem_min` real,
	`light_min` real,
	`awake_min` real,
	`source` text
);
--> statement-breakpoint
CREATE INDEX `idx_sleep_sessions_started_at` ON `sleep_sessions` (`started_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_sleep_sessions_external_id` ON `sleep_sessions` (`external_id`);