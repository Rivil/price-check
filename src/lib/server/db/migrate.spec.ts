import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from './client.ts';
import { migrateDb, migrationsFolder } from './migrate.ts';
import { notifyChannel, priceDropDelivery, user } from './schema.ts';
import { MIGRATIONS_FOLDER } from '../testing/auth-harness.ts';

let dir: string;
let db: Db;

async function tables() {
	const rows = await db.$client.execute(
		"select name from sqlite_master where type = 'table' order by name"
	);
	return rows.rows.map((row) => String(row.name));
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'apc-migrate-'));
	db = createDb(`file:${join(dir, 'app.db')}`);
});
afterEach(() => {
	db.$client.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('migrateDb', () => {
	it('migrationsFolder', () => {
		expect(migrationsFolder('/app')).toBe('/app/drizzle');
		// The tests run from the repo root, where the real migrations live.
		expect(migrationsFolder()).toBe(MIGRATIONS_FOLDER);
	});

	it('creates every table on an empty database, then is a no-op', async () => {
		expect(await tables()).toEqual([]);

		await migrateDb(db);
		const created = await tables();
		expect(created).toEqual(
			expect.arrayContaining(['user', 'session', 'watch', 'price_point', 'alert_channel'])
		);

		const applied = await db.$client.execute('select count(*) as n from __drizzle_migrations');
		await migrateDb(db);
		expect(await tables()).toEqual(created);
		const reapplied = await db.$client.execute('select count(*) as n from __drizzle_migrations');
		expect(reapplied.rows[0].n).toBe(applied.rows[0].n);
	});

	// A database as it stood before 0007 (the real folder cut off at 0006), seeded
	// with raw SQL so later schema changes to watch don't rewrite the old shape.
	it('upgrade', async () => {
		const folder = join(dir, 'drizzle');
		cpSync(MIGRATIONS_FOLDER, folder, { recursive: true });
		const journalFile = join(folder, 'meta', '_journal.json');
		const journal = JSON.parse(readFileSync(journalFile, 'utf8'));
		journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= 6);
		writeFileSync(journalFile, JSON.stringify(journal));
		await migrateDb(db, folder);
		expect(await tables()).not.toContain('notify_channel');

		await db.insert(user).values([
			{ id: 'alice', name: 'Alice', email: 'alice@example.test' },
			{ id: 'bob', name: 'Bob', email: 'bob@example.test' }
		]);
		await db.$client.execute({
			sql: 'insert into alert_channel (user_id, ntfy_url, ntfy_token) values (?, ?, ?)',
			args: ['alice', 'https://ntfy.sh/alice-legacy', 'tk_aliceAAAAAAAAAAAAAAAAAAAAAAAAA']
		});
		const ALERTED_AT = 1_700_000_000_000;
		for (const [id, owner, target, alertedAt] of [
			['w1', 'alice', 2000, ALERTED_AT],
			['w2', 'alice', 1500, null],
			['w3', 'alice', null, ALERTED_AT],
			['w4', 'bob', 900, ALERTED_AT]
		] as const) {
			await db.$client.execute({
				sql: `insert into watch (id, user_id, shop, product_id, canonical_url, target_pence, alerted_at)
					values (?, ?, 'amazon-uk', ?, ?, ?, ?)`,
				args: [id, owner, id, `https://www.amazon.co.uk/dp/${id}`, target, alertedAt]
			});
		}

		await migrateDb(db, MIGRATIONS_FOLDER);

		expect(
			await db
				.select({
					userId: notifyChannel.userId,
					kind: notifyChannel.kind,
					enabled: notifyChannel.enabled,
					priceDrops: notifyChannel.priceDrops,
					checkFailures: notifyChannel.checkFailures,
					configEnc: notifyChannel.configEnc
				})
				.from(notifyChannel)
		).toEqual([
			{
				userId: 'alice',
				kind: 'ntfy',
				enabled: true,
				priceDrops: true,
				checkFailures: true,
				configEnc: null
			}
		]);
		expect(
			await db
				.select({
					watchId: priceDropDelivery.watchId,
					kind: priceDropDelivery.kind,
					targetPence: priceDropDelivery.targetPence
				})
				.from(priceDropDelivery)
		).toEqual([{ watchId: 'w1', kind: 'ntfy', targetPence: 2000 }]);
		const [delivered] = await db
			.select({ userId: priceDropDelivery.userId, deliveredAt: priceDropDelivery.deliveredAt })
			.from(priceDropDelivery);
		expect(delivered).toEqual({ userId: 'alice', deliveredAt: new Date(ALERTED_AT) });

		// Bob had no legacy channel: nothing seeded for him.
		expect(await db.select().from(notifyChannel).where(eq(notifyChannel.userId, 'bob'))).toEqual(
			[]
		);
		expect(
			await db.select().from(priceDropDelivery).where(eq(priceDropDelivery.userId, 'bob'))
		).toEqual([]);

		// The legacy row stays for the startup backfill to encrypt and move.
		const legacy = await db.$client.execute('select user_id from alert_channel');
		expect(legacy.rows.map((row) => row.user_id)).toEqual(['alice']);
	});
});
