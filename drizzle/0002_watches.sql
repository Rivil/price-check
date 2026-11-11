CREATE TABLE `watch` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`shop` text NOT NULL,
	`product_id` text NOT NULL,
	`canonical_url` text NOT NULL,
	`title` text,
	`image_url` text,
	`price_pence` integer,
	`target_pence` integer,
	`last_checked_at` integer,
	`last_check_reason` text,
	`last_check_message` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `watch_user_product_uq` ON `watch` (`user_id`,`shop`,`product_id`);--> statement-breakpoint
CREATE INDEX `watch_userId_idx` ON `watch` (`user_id`);