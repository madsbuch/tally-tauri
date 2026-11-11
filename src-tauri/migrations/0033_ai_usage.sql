CREATE TABLE `ai_usage` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`created_at` text NOT NULL,
	`day` text NOT NULL,
	`source` text NOT NULL,
	`chat_id` integer,
	`model` text NOT NULL,
	`requests` integer NOT NULL,
	`prompt_tokens` integer NOT NULL,
	`cached_tokens` integer NOT NULL,
	`completion_tokens` integer NOT NULL,
	`cost_usd` real NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_ai_usage_day` ON `ai_usage` (`day`);--> statement-breakpoint
CREATE INDEX `idx_ai_usage_chat` ON `ai_usage` (`chat_id`);