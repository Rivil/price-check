// A user's alert channels: at most one per type (decision channels_per_type), keyed
// (user, kind). The channel's settings — topic, token, API key, … — live in one
// encrypted JSON blob (decision encryption_key); config_enc is null only for a row
// the 0007 upgrade seeded from the legacy alert_channel, until the server's startup
// backfill encrypts it (SQL cannot).
//
// price_drop_delivery replaces watch.alerted_at (decision delivery_state_per_channel):
// one row per (watch, channel kind) that has received the drop alert for target_pence.
import { sql } from 'drizzle-orm';
import { foreignKey, index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { user } from './auth.schema.ts';
import { watch } from './watch.schema.ts';

export const notifyChannel = sqliteTable(
	'notify_channel',
	{
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		/** Channel type, e.g. 'ntfy'; one row per type per user. */
		kind: text('kind').notNull(),
		enabled: integer('enabled', { mode: 'boolean' }).default(true).notNull(),
		/** Receives price-drop alerts. */
		priceDrops: integer('price_drops', { mode: 'boolean' }).default(true).notNull(),
		/** Receives failed-check alerts. */
		checkFailures: integer('check_failures', { mode: 'boolean' }).default(true).notNull(),
		/** 'v1:…' AES-256-GCM ciphertext of the channel's JSON config; null until backfilled. */
		configEnc: text('config_enc'),
		updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.$onUpdate(() => new Date())
			.notNull()
	},
	(table) => [primaryKey({ columns: [table.userId, table.kind] })]
);

export const priceDropDelivery = sqliteTable(
	'price_drop_delivery',
	{
		watchId: text('watch_id')
			.notNull()
			.references(() => watch.id, { onDelete: 'cascade' }),
		kind: text('kind').notNull(),
		userId: text('user_id').notNull(),
		/** The target the delivered alert was for; a changed target re-arms. */
		targetPence: integer('target_pence').notNull(),
		deliveredAt: integer('delivered_at', { mode: 'timestamp_ms' })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull()
	},
	(table) => [
		primaryKey({ columns: [table.watchId, table.kind] }),
		foreignKey({
			columns: [table.userId, table.kind],
			foreignColumns: [notifyChannel.userId, notifyChannel.kind]
		}).onDelete('cascade'),
		index('price_drop_delivery_channel_idx').on(table.userId, table.kind)
	]
);
