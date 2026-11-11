// A user's watch on one shop product. Per-user by design (no shared watches): the
// same product watched by two household members is two rows with their own targets.
import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { user } from './auth.schema.ts';

export const watch = sqliteTable(
	'watch',
	{
		id: text('id').primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
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
	(table) => [
		uniqueIndex('watch_user_product_uq').on(table.userId, table.shop, table.productId),
		index('watch_userId_idx').on(table.userId)
	]
);
