CREATE TABLE `manual_revisions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`manual_id` integer NOT NULL,
	`title` text NOT NULL,
	`situation` text NOT NULL,
	`body` text NOT NULL,
	`edited_by` text NOT NULL,
	`written_at` text NOT NULL,
	FOREIGN KEY (`manual_id`) REFERENCES `manuals`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_manual_revisions_manual` ON `manual_revisions` (`manual_id`);--> statement-breakpoint
CREATE TABLE `manuals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`situation` text NOT NULL,
	`applies_when` text,
	`body` text NOT NULL,
	`edited_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
