CREATE TABLE `state_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`logged_at` text NOT NULL,
	`label` text NOT NULL,
	`icon` text,
	`note` text,
	`day` text NOT NULL,
	`tz_offset_min` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_state_logs_day` ON `state_logs` (`day`);--> statement-breakpoint
CREATE INDEX `idx_state_logs_logged_at` ON `state_logs` (`logged_at`);