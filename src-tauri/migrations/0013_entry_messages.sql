CREATE TABLE `entry_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`entry_kind` text NOT NULL,
	`entry_id` integer NOT NULL,
	`role` text NOT NULL,
	`text` text NOT NULL,
	`changes` text DEFAULT '[]' NOT NULL,
	`before_entry` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_entry_messages_entry` ON `entry_messages` (`entry_kind`,`entry_id`);