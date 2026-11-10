CREATE TABLE `experiment_trials` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`experiment_id` integer NOT NULL,
	`arm` text NOT NULL,
	`fast_id` integer,
	`started_at` text NOT NULL,
	`day` text NOT NULL,
	`tz_offset_min` integer NOT NULL,
	`ratings` text,
	`note` text,
	`excluded` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`experiment_id`) REFERENCES `experiments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_experiment_trials_experiment` ON `experiment_trials` (`experiment_id`);--> statement-breakpoint
CREATE INDEX `idx_experiment_trials_fast` ON `experiment_trials` (`fast_id`);--> statement-breakpoint
CREATE TABLE `experiments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`hypothesis` text NOT NULL,
	`applies_when` text,
	`arms` text NOT NULL,
	`measures` text NOT NULL,
	`assignment` text NOT NULL,
	`target_per_arm` integer NOT NULL,
	`status` text NOT NULL,
	`conclusion` text,
	`manual_id` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`ended_at` text
);
