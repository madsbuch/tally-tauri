CREATE TABLE `life_rule_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`rule_id` integer NOT NULL,
	`rule_text` text NOT NULL,
	`logged_at` text NOT NULL,
	`day` text NOT NULL,
	`tz_offset_min` integer NOT NULL,
	`situation` text,
	`belief` integer,
	`acted_on` text,
	FOREIGN KEY (`rule_id`) REFERENCES `life_rules`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_life_rule_logs_day` ON `life_rule_logs` (`day`);--> statement-breakpoint
CREATE INDEX `idx_life_rule_logs_rule` ON `life_rule_logs` (`rule_id`);--> statement-breakpoint
CREATE TABLE `life_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`text` text NOT NULL,
	`alternative` text,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`day` text NOT NULL,
	`tz_offset_min` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_life_rules_status` ON `life_rules` (`status`);--> statement-breakpoint
CREATE INDEX `idx_life_rules_day` ON `life_rules` (`day`);