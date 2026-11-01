CREATE TABLE `entry_notes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`entry_kind` text NOT NULL,
	`entry_id` integer NOT NULL,
	`text` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_entry_notes_entry` ON `entry_notes` (`entry_kind`,`entry_id`);