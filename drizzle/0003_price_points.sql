CREATE TABLE `price_point` (
	`id` text PRIMARY KEY NOT NULL,
	`watch_id` text NOT NULL,
	`price_pence` integer NOT NULL,
	`checked_at` integer NOT NULL,
	FOREIGN KEY (`watch_id`) REFERENCES `watch`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `price_point_watch_checked_idx` ON `price_point` (`watch_id`,`checked_at`);