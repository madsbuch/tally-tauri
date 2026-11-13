CREATE TABLE `document_files` (
	`document_id` integer PRIMARY KEY NOT NULL,
	`filename` text NOT NULL,
	`media_type` text NOT NULL,
	`data` blob NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade
);
