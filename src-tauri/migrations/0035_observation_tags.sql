CREATE TABLE `state_log_tags` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`log_id` integer NOT NULL,
	`label` text NOT NULL,
	`icon` text,
	FOREIGN KEY (`log_id`) REFERENCES `state_logs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_state_log_tags_log` ON `state_log_tags` (`log_id`);--> statement-breakpoint
CREATE INDEX `idx_state_log_tags_label` ON `state_log_tags` (`label`);--> statement-breakpoint
ALTER TABLE `state_logs` ADD `tagging` text;--> statement-breakpoint
-- Every observation so far had exactly one label; it becomes its one tag.
INSERT INTO state_log_tags (log_id, label, icon)
  SELECT id, label, icon FROM state_logs ORDER BY id;--> statement-breakpoint
ALTER TABLE `state_logs` DROP COLUMN `label`;--> statement-breakpoint
ALTER TABLE `state_logs` DROP COLUMN `icon`;