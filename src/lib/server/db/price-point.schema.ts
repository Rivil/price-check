// One successful check of a watch: the price it found and when. Failed checks
// add no point (decision failure_keeps_price); every success does, even when the
// price is unchanged (decision every_success_is_a_point).
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { watch } from './watch.schema.ts';

export const pricePoint = sqliteTable(
	'price_point',
	{
		id: text('id').primaryKey(),
		watchId: text('watch_id')
			.notNull()
			.references(() => watch.id, { onDelete: 'cascade' }),
		pricePence: integer('price_pence').notNull(),
		checkedAt: integer('checked_at', { mode: 'timestamp_ms' }).notNull()
	},
	(table) => [index('price_point_watch_checked_idx').on(table.watchId, table.checkedAt)]
);
