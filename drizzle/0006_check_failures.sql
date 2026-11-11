CREATE TABLE `check_failure` (
	`id` text PRIMARY KEY NOT NULL,
	`watch_id` text NOT NULL,
	`reason` text NOT NULL,
	`message` text,
	`checked_at` integer NOT NULL,
	FOREIGN KEY (`watch_id`) REFERENCES `watch`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `check_failure_watch_checked_idx` ON `check_failure` (`watch_id`,`checked_at`);
--> statement-breakpoint
INSERT INTO `check_failure` (`id`, `watch_id`, `reason`, `message`, `checked_at`)
SELECT lower(hex(randomblob(16))), `id`, `last_check_reason`, `last_check_message`, coalesce(`last_checked_at`, `created_at`)
FROM `watch`
WHERE `last_check_reason` IS NOT NULL;
