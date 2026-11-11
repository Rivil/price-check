// A user's one push channel (decision channel_ntfy): the ntfy topic URL alerts go
// to. The URL is a secret — anyone who knows an ntfy.sh topic can read it — so it
// is only ever shown back to its owner (decision topic_is_secret).
import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { user } from './auth.schema.ts';

export const alertChannel = sqliteTable('alert_channel', {
	userId: text('user_id')
		.primaryKey()
		.references(() => user.id, { onDelete: 'cascade' }),
	ntfyUrl: text('ntfy_url').notNull(),
	// Access token for a server that refuses anonymous publishes (auth-default-access
	// deny-all). A credential: never shown back, logged or put into an error.
	ntfyToken: text('ntfy_token'),
	updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
		.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
		.$onUpdate(() => new Date())
		.notNull()
});
