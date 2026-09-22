CREATE TABLE `documents` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`created_at` text NOT NULL,
	`document_date` text,
	`title` text NOT NULL,
	`kind` text DEFAULT 'other' NOT NULL,
	`photo_path` text,
	`note` text,
	`summary` text,
	`extracted` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`error` text,
	`model_id` text
);
--> statement-breakpoint
CREATE INDEX `idx_documents_document_date` ON `documents` (`document_date`);