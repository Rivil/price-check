CREATE TABLE `notify_channel` (
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`price_drops` integer DEFAULT true NOT NULL,
	`check_failures` integer DEFAULT true NOT NULL,
	`config_enc` text,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	PRIMARY KEY(`user_id`, `kind`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `price_drop_delivery` (
	`watch_id` text NOT NULL,
	`kind` text NOT NULL,
	`user_id` text NOT NULL,
	`target_pence` integer NOT NULL,
	`delivered_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	PRIMARY KEY(`watch_id`, `kind`),
	FOREIGN KEY (`watch_id`) REFERENCES `watch`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`,`kind`) REFERENCES `notify_channel`(`user_id`,`kind`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `price_drop_delivery_channel_idx` ON `price_drop_delivery` (`user_id`,`kind`);--> statement-breakpoint
-- Upgrade: each legacy ntfy channel becomes an enabled ntfy channel for both alert
-- kinds. SQL cannot encrypt, so config_enc stays null until the server's startup
-- backfill moves the topic and token across.
INSERT INTO `notify_channel` (`user_id`, `kind`, `enabled`, `price_drops`, `check_failures`, `config_enc`, `updated_at`)
SELECT `user_id`, 'ntfy', 1, 1, 1, NULL, `updated_at`
FROM `alert_channel`;
--> statement-breakpoint
-- A drop already alerted under the old single alerted_at bit counts as delivered to
-- that user's ntfy channel, so the upgrade sends no repeat alert.
INSERT INTO `price_drop_delivery` (`watch_id`, `kind`, `user_id`, `target_pence`, `delivered_at`)
SELECT `watch`.`id`, 'ntfy', `watch`.`user_id`, `watch`.`target_pence`, `watch`.`alerted_at`
FROM `watch`
INNER JOIN `alert_channel` ON `alert_channel`.`user_id` = `watch`.`user_id`
WHERE `watch`.`alerted_at` IS NOT NULL AND `watch`.`target_pence` IS NOT NULL;
