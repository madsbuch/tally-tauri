CREATE TABLE `coach_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`trigger_key` text NOT NULL,
	`day` text NOT NULL,
	`created_at` text NOT NULL,
	`chat_id` integer
);
--> statement-breakpoint
CREATE INDEX `idx_coach_runs_day` ON `coach_runs` (`day`);