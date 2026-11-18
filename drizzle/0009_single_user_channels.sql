DROP TABLE `alert_channel`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_notify_channel` (
	`kind` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`price_drops` integer DEFAULT true NOT NULL,
	`check_failures` integer DEFAULT true NOT NULL,
	`config_enc` text,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_notify_channel`("kind", "enabled", "price_drops", "check_failures", "config_enc", "updated_at") SELECT "kind", "enabled", "price_drops", "check_failures", "config_enc", "updated_at" FROM `notify_channel`;--> statement-breakpoint
DROP TABLE `notify_channel`;--> statement-breakpoint
ALTER TABLE `__new_notify_channel` RENAME TO `notify_channel`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_price_drop_delivery` (
	`watch_id` text NOT NULL,
	`kind` text NOT NULL,
	`target_pence` integer NOT NULL,
	`delivered_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	PRIMARY KEY(`watch_id`, `kind`),
	FOREIGN KEY (`watch_id`) REFERENCES `watch`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`kind`) REFERENCES `notify_channel`(`kind`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_price_drop_delivery`("watch_id", "kind", "target_pence", "delivered_at") SELECT "watch_id", "kind", "target_pence", "delivered_at" FROM `price_drop_delivery`;--> statement-breakpoint
DROP TABLE `price_drop_delivery`;--> statement-breakpoint
ALTER TABLE `__new_price_drop_delivery` RENAME TO `price_drop_delivery`;--> statement-breakpoint
CREATE INDEX `price_drop_delivery_channel_idx` ON `price_drop_delivery` (`kind`);--> statement-breakpoint
-- Hand-added. A database where two users have a channel of the same kind fails the
-- __new_notify_channel insert above (kind is the key now), and the migrator rolls
-- this whole file back: multi-user databases are unsupported (decision data_scope).
--
-- A channel the 0007 upgrade seeded but the startup backfill never encrypted has no
-- settings to keep, and the backfill is gone, so it goes with its deliveries. The
-- migrator runs with foreign keys off, so the deliveries are deleted explicitly.
DELETE FROM `price_drop_delivery`
WHERE `kind` IN (SELECT `kind` FROM `notify_channel` WHERE `config_enc` IS NULL);
--> statement-breakpoint
DELETE FROM `notify_channel` WHERE `config_enc` IS NULL;
