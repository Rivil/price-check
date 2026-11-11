// One failed check of a watch: why it failed and when. Every failure gets a row,
// consecutive ones included, so the chart and history can show each at its own
// time. Failures from before this table existed were never kept (decision
// failure_backfill); the migration copies only each watch's current one.
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { watch } from './watch.schema.ts';

export const checkFailure = sqliteTable(
	'check_failure',
	{
		id: text('id').primaryKey(),
		watchId: text('watch_id')
			.notNull()
			.references(() => watch.id, { onDelete: 'cascade' }),
		reason: text('reason').notNull(),
		message: text('message'),
		checkedAt: integer('checked_at', { mode: 'timestamp_ms' }).notNull()
	},
	(table) => [index('check_failure_watch_checked_idx').on(table.watchId, table.checkedAt)]
);
