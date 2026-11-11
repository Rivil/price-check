CREATE TABLE `alert_channel` (
	`user_id` text PRIMARY KEY NOT NULL,
	`ntfy_url` text NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `watch` ADD `alerted_at` integer;