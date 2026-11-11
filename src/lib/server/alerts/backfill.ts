// Moves each legacy plaintext ntfy channel (alert_channel) into encrypted storage
// (notify_channel), at startup after migrating: the 0007 migration seeded the rows
// but SQL cannot encrypt. Once a user's encrypted config is stored, their legacy
// row is deleted and the file VACUUMed, so the plaintext topic and token do not
// linger in free pages (c-8). A crash between the DELETE and the VACUUM leaves
// freed pages until the next scrub — an accepted gap; no secure_delete pragma.
//
// The topic URL is kept verbatim, even one today's parser would refuse: rejecting it
// here would silently drop a working channel. Logs name users and counts only.
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { alertChannel, notifyChannel } from '../db/schema.ts';
import { channelAad, encryptSecret } from './crypto.ts';

export type Logger = (message: string) => void;

const defaultLog: Logger = (message) => console.log(message);

/**
 * For every legacy row whose ntfy channel has no saved settings yet, stores the
 * encrypted {url, token}; a channel row missing altogether is created enabled for
 * both alert kinds. A channel that already has settings is never overwritten. Each
 * legacy row whose user now has encrypted settings is then deleted. One user's
 * failure is logged and their legacy row kept. Idempotent.
 */
export async function backfillLegacyNtfy(
	db: Db,
	key: Buffer,
	log: Logger = defaultLog
): Promise<{ moved: number }> {
	const legacy = await db.select().from(alertChannel);
	let moved = 0;
	const stored: string[] = [];
	for (const row of legacy) {
		try {
			const [existing] = await db
				.select({ configEnc: notifyChannel.configEnc })
				.from(notifyChannel)
				.where(and(eq(notifyChannel.userId, row.userId), eq(notifyChannel.kind, 'ntfy')));
			if (existing !== undefined && existing.configEnc !== null) {
				stored.push(row.userId);
				continue;
			}

			const configEnc = encryptSecret(
				key,
				JSON.stringify({ url: row.ntfyUrl, token: row.ntfyToken ?? null }),
				channelAad(row.userId, 'ntfy')
			);
			const written = await db
				.insert(notifyChannel)
				.values({
					userId: row.userId,
					kind: 'ntfy',
					enabled: true,
					priceDrops: true,
					checkFailures: true,
					configEnc
				})
				.onConflictDoUpdate({
					target: [notifyChannel.userId, notifyChannel.kind],
					set: { configEnc },
					// A save that landed in between wins.
					setWhere: isNull(notifyChannel.configEnc)
				})
				.returning({ userId: notifyChannel.userId });
			moved += written.length;
			// Written now, or by a save that landed in between: either way it is stored.
			stored.push(row.userId);
		} catch (error) {
			log(
				`[alerts] could not move the ntfy channel of user ${row.userId} (${error instanceof Error ? error.name : 'error'})`
			);
		}
	}
	if (moved > 0) log(`[alerts] moved ${moved} ntfy channel(s) to encrypted storage`);
	if (stored.length > 0) {
		await db.delete(alertChannel).where(inArray(alertChannel.userId, stored));
		// Rewrites the file without the deleted rows' pages.
		await db.$client.execute('VACUUM');
	}
	return { moved };
}
