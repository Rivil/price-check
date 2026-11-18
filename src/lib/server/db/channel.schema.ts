// The install's alert channels: at most one per type (decision channels_per_type),
// keyed by kind. The channel's settings — topic, token, API key, … — live in one
// encrypted JSON blob (decision encryption_key); config_enc null means no readable
// settings are stored (the 0009 migration deletes any such row left from 0007).
//
// price_drop_delivery replaces watch.alerted_at (decision delivery_state_per_channel):
// one row per (watch, channel kind) that has received the drop alert for target_pence.
import { sql } from 'drizzle-orm';
import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { watch } from './watch.schema.ts';

export const notifyChannel = sqliteTable('notify_channel', {
	/** Channel type, e.g. 'ntfy'; one row per type. */
	kind: text('kind').primaryKey(),
	enabled: integer('enabled', { mode: 'boolean' }).default(true).notNull(),
	/** Receives price-drop alerts. */
	priceDrops: integer('price_drops', { mode: 'boolean' }).default(true).notNull(),
	/** Receives failed-check alerts. */
	checkFailures: integer('check_failures', { mode: 'boolean' }).default(true).notNull(),
	/** 'v1:…' AES-256-GCM ciphertext of the channel's JSON config. */
	configEnc: text('config_enc'),
	updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
		.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
		.$onUpdate(() => new Date())
		.notNull()
});

export const priceDropDelivery = sqliteTable(
	'price_drop_delivery',
	{
		watchId: text('watch_id')
			.notNull()
			.references(() => watch.id, { onDelete: 'cascade' }),
		kind: text('kind')
			.notNull()
			.references(() => notifyChannel.kind, { onDelete: 'cascade' }),
		/** The target the delivered alert was for; a changed target re-arms. */
		targetPence: integer('target_pence').notNull(),
		deliveredAt: integer('delivered_at', { mode: 'timestamp_ms' })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull()
	},
	(table) => [
		primaryKey({ columns: [table.watchId, table.kind] }),
		index('price_drop_delivery_channel_idx').on(table.kind)
	]
);
