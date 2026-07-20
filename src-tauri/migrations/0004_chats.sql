CREATE TABLE `chats` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`title` text NOT NULL,
	`messages` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_chats_updated_at` ON `chats` (`updated_at`);