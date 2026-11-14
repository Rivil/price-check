// A watch on one shop product. The data belongs to the install, not a user (decision
// data_scope): one watch per product, whoever added it.
import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const watch = sqliteTable(
	'watch',
	{
		id: text('id').primaryKey(),
		/** Shop adapter id, e.g. 'amazon-uk'. */
		shop: text('shop').notNull(),
		/** The shop's product id, e.g. the ASIN. */
		productId: text('product_id').notNull(),
		canonicalUrl: text('canonical_url').notNull(),
		// Null until a check succeeds: a watch stored from a failed first check has
		// no title, image or price yet.
		title: text('title'),
		imageUrl: text('image_url'),
		pricePence: integer('price_pence'),
		/** Optional; a watch without a target only tracks the price. */
		targetPence: integer('target_pence'),
		lastCheckedAt: integer('last_checked_at', { mode: 'timestamp_ms' }),
		/** The failure reason of the last check; null when it succeeded. */
		lastCheckReason: text('last_check_reason'),
		lastCheckMessage: text('last_check_message'),
		createdAt: integer('created_at', { mode: 'timestamp_ms' })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull()
	},
	(table) => [uniqueIndex('watch_product_uq').on(table.shop, table.productId)]
);
