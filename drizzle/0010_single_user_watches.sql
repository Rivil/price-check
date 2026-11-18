PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_watch` (
	`id` text PRIMARY KEY NOT NULL,
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
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_watch`("id", "shop", "product_id", "canonical_url", "title", "image_url", "price_pence", "target_pence", "last_checked_at", "last_check_reason", "last_check_message", "created_at") SELECT "id", "shop", "product_id", "canonical_url", "title", "image_url", "price_pence", "target_pence", "last_checked_at", "last_check_reason", "last_check_message", "created_at" FROM `watch`;--> statement-breakpoint
DROP TABLE `watch`;--> statement-breakpoint
ALTER TABLE `__new_watch` RENAME TO `watch`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
-- Hand-added. A database where two users watch the same product fails this index
-- (one watch per product now), and the migrator rolls this whole file back:
-- multi-user databases are unsupported (decision data_scope).
CREATE UNIQUE INDEX `watch_product_uq` ON `watch` (`shop`,`product_id`);