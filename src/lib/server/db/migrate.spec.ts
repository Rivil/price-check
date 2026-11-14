import { randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listChannels, saveChannel } from '../alerts/channels.ts';
import { encryptSecret } from '../alerts/crypto.ts';
import { priceHistory } from '../checks.ts';
import { MIGRATIONS_FOLDER } from '../testing/test-db.ts';
import { removeTempDir } from '../testing/temp-dir.ts';
import { listWatches } from '../watches.ts';
import { createDb, type Db } from './client.ts';
import { migrateDb, migrationsFolder } from './migrate.ts';
import { notifyChannel, pricePoint, priceDropDelivery, watch } from './schema.ts';

let dir: string;
let db: Db;

type Journal = { entries: { idx: number; when: number; tag: string }[] };
const journal = JSON.parse(
	readFileSync(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8')
) as Journal;
const entry = (idx: number) => journal.entries.find((e) => e.idx === idx)!;

const run = (sql: string, args: (string | number | null)[] = []) =>
	db.$client.execute({ sql, args });

async function tables() {
	const rows = await run("select name from sqlite_master where type = 'table' order by name");
	return rows.rows.map((row) => String(row.name));
}

async function columns(table: string) {
	const rows = await run(`select name, pk from pragma_table_info('${table}') order by cid`);
	return rows.rows.map((row) => ({ name: String(row.name), pk: Number(row.pk) }));
}

const ids = async (table: string, column = 'id') =>
	(await run(`select ${column} as id from ${table} order by ${column}`)).rows.map((r) =>
		String(r.id)
	);

/** The last applied migration's journal time, as the migrator records it. */
async function lastApplied() {
	const rows = await run('select created_at from __drizzle_migrations order by created_at desc');
	return { count: rows.rows.length, when: Number(rows.rows[0].created_at) };
}

/** The real migrations folder cut off after `maxIdx`, as a database stood back then. */
function folderUpTo(maxIdx: number) {
	const folder = join(dir, `drizzle-${maxIdx}`);
	cpSync(MIGRATIONS_FOLDER, folder, { recursive: true });
	const journalFile = join(folder, 'meta', '_journal.json');
	const cut = JSON.parse(readFileSync(journalFile, 'utf8')) as Journal;
	cut.entries = cut.entries.filter((e) => e.idx <= maxIdx);
	writeFileSync(journalFile, JSON.stringify(cut));
	return folder;
}

/** Every table's schema and rows, for "left exactly as it was" comparisons. */
async function dump() {
	const schema = await run('select type, name, sql from sqlite_master order by type, name');
	const data: Record<string, unknown[]> = {};
	for (const name of await tables()) {
		data[name] = (await run(`select * from "${name}" order by rowid`)).rows.map((row) => ({
			...row
		}));
	}
	return { schema: schema.rows.map((row) => ({ ...row })), data };
}

// A channel config sealed the way 0007-0008 servers did: per-user AAD, a key of its own.
const sealedLegacy = (userId: string, kind: string) =>
	encryptSecret(
		randomBytes(32),
		JSON.stringify({ url: `https://ntfy.sh/${userId}-topic`, token: null }),
		JSON.stringify(['alert-channel', userId, kind])
	);

async function addUser(id: string) {
	await run('insert into user (id, name, email) values (?, ?, ?)', [id, id, `${id}@example.test`]);
}

async function addWatch(id: string, owner: string) {
	await run(
		`insert into watch (id, user_id, shop, product_id, canonical_url, target_pence)
			values (?, ?, 'amazon-uk', ?, ?, 2000)`,
		[id, owner, id, `https://www.amazon.co.uk/dp/${id}`]
	);
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'apc-migrate-'));
	db = createDb(`file:${join(dir, 'app.db')}`);
});
afterEach(() => {
	db.$client.close();
	removeTempDir(dir);
});

describe('migrateDb', () => {
	it('migrationsFolder', () => {
		// Shape, not a re-run of resolve(): absolute, ending in app/drizzle (any separator).
		const folder = migrationsFolder('/app');
		expect(isAbsolute(folder)).toBe(true);
		expect(folder).toMatch(/[\\/]app[\\/]drizzle$/);
		// The tests run from the repo root, where the real migrations live.
		expect(migrationsFolder()).toBe(MIGRATIONS_FOLDER);
	});

	it('creates every table on an empty database, then is a no-op', async () => {
		expect(await tables()).toEqual([]);

		await migrateDb(db);
		const created = await tables();
		expect(created).toEqual(
			expect.arrayContaining(['watch', 'price_point', 'notify_channel', 'price_drop_delivery'])
		);
		expect(created).not.toContain('alert_channel');

		const applied = await lastApplied();
		expect(applied.count).toBe(journal.entries.length);
		await migrateDb(db);
		expect(await tables()).toEqual(created);
		expect(await lastApplied()).toEqual(applied);
	});

	// A database as it stood before 0007 (the real folder cut off at 0006), seeded
	// with raw SQL so later schema changes don't rewrite the old shape; upgraded to 0008.
	it('upgrade 0006->0008', async () => {
		await migrateDb(db, folderUpTo(6));
		expect(await tables()).not.toContain('notify_channel');

		await addUser('alice');
		await addUser('bob');
		await run('insert into alert_channel (user_id, ntfy_url, ntfy_token) values (?, ?, ?)', [
			'alice',
			'https://ntfy.sh/alice-legacy',
			'tk_aliceAAAAAAAAAAAAAAAAAAAAAAAAA'
		]);
		const ALERTED_AT = 1_700_000_000_000;
		for (const [id, owner, target, alertedAt] of [
			['w1', 'alice', 2000, ALERTED_AT],
			['w2', 'alice', 1500, null],
			['w3', 'alice', null, ALERTED_AT],
			['w4', 'bob', 900, ALERTED_AT]
		] as const) {
			await run(
				`insert into watch (id, user_id, shop, product_id, canonical_url, target_pence, alerted_at)
					values (?, ?, 'amazon-uk', ?, ?, ?, ?)`,
				[id, owner, id, `https://www.amazon.co.uk/dp/${id}`, target, alertedAt]
			);
		}

		await migrateDb(db, folderUpTo(8));

		const channels = await run(
			'select user_id, kind, enabled, price_drops, check_failures, config_enc from notify_channel'
		);
		expect(channels.rows.map((row) => ({ ...row }))).toEqual([
			{
				user_id: 'alice',
				kind: 'ntfy',
				enabled: 1,
				price_drops: 1,
				check_failures: 1,
				config_enc: null
			}
		]);
		// Bob had no legacy channel: nothing seeded for him.
		const delivered = await run(
			'select watch_id, kind, user_id, target_pence, delivered_at from price_drop_delivery'
		);
		expect(delivered.rows.map((row) => ({ ...row }))).toEqual([
			{
				watch_id: 'w1',
				kind: 'ntfy',
				user_id: 'alice',
				target_pence: 2000,
				delivered_at: ALERTED_AT
			}
		]);
		// The legacy row stayed for the (since removed) startup backfill.
		expect(await ids('alert_channel', 'user_id')).toEqual(['alice']);
	});

	// One user's install at 0008, its channel encrypted: every row keeps its id.
	it('upgrade 0008->0009', async () => {
		await migrateDb(db, folderUpTo(8));
		expect(await lastApplied()).toMatchObject({ when: entry(8).when });

		await addUser('alice');
		await addWatch('w1', 'alice');
		await addWatch('w2', 'alice');
		for (const [id, watchId, at] of [
			['p1', 'w1', 1],
			['p2', 'w1', 2],
			['p3', 'w1', 3],
			['p4', 'w2', 1],
			['p5', 'w2', 2]
		] as const) {
			await run(
				'insert into price_point (id, watch_id, price_pence, checked_at) values (?, ?, 1999, ?)',
				[id, watchId, 1_700_000_000_000 + at]
			);
		}
		const sealed = sealedLegacy('alice', 'ntfy');
		await run(
			`insert into notify_channel (user_id, kind, enabled, price_drops, check_failures, config_enc, updated_at)
				values ('alice', 'ntfy', 1, 1, 0, ?, 1700000000000)`,
			[sealed]
		);
		await run(
			`insert into price_drop_delivery (watch_id, kind, user_id, target_pence, delivered_at)
				values ('w1', 'ntfy', 'alice', 2000, 1700000000005)`
		);

		await migrateDb(db, MIGRATIONS_FOLDER);

		// 0009 ran: its journal time is later than 0008's, and it is the last applied.
		expect(entry(9).tag).toBe('0009_single_user_channels');
		expect(entry(9).when).toBeGreaterThan(entry(8).when);
		expect((await lastApplied()).when).toBe(journal.entries.at(-1)!.when);

		expect(await ids('watch')).toEqual(['w1', 'w2']);
		expect(await ids('price_point')).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
		expect(await db.select().from(notifyChannel)).toEqual([
			{
				kind: 'ntfy',
				enabled: true,
				priceDrops: true,
				checkFailures: false,
				configEnc: sealed,
				updatedAt: new Date(1_700_000_000_000)
			}
		]);
		expect(await db.select().from(priceDropDelivery)).toEqual([
			{
				watchId: 'w1',
				kind: 'ntfy',
				targetPence: 2000,
				deliveredAt: new Date(1_700_000_000_005)
			}
		]);

		// Keyed by kind alone now; no user_id anywhere in either table.
		expect(await columns('notify_channel')).toEqual([
			{ name: 'kind', pk: 1 },
			{ name: 'enabled', pk: 0 },
			{ name: 'price_drops', pk: 0 },
			{ name: 'check_failures', pk: 0 },
			{ name: 'config_enc', pk: 0 },
			{ name: 'updated_at', pk: 0 }
		]);
		expect(await columns('price_drop_delivery')).toEqual([
			{ name: 'watch_id', pk: 1 },
			{ name: 'kind', pk: 2 },
			{ name: 'target_pence', pk: 0 },
			{ name: 'delivered_at', pk: 0 }
		]);
		const fks = await run(
			`select "table", "from", "to", on_delete from pragma_foreign_key_list('price_drop_delivery') order by "from"`
		);
		expect(fks.rows.map((row) => ({ ...row }))).toEqual([
			{ table: 'notify_channel', from: 'kind', to: 'kind', on_delete: 'CASCADE' },
			{ table: 'watch', from: 'watch_id', to: 'id', on_delete: 'CASCADE' }
		]);
		expect((await run('pragma foreign_key_check')).rows).toEqual([]);
		expect(await tables()).not.toContain('alert_channel');
		expect((await tables()).filter((name) => name.startsWith('__new_'))).toEqual([]);
	});

	it('0009 drops unencrypted channels, their deliveries and alert_channel', async () => {
		await migrateDb(db, folderUpTo(8));
		await addUser('alice');
		await addWatch('w1', 'alice');
		await addWatch('w2', 'alice');
		// A legacy plaintext row the backfill never moved, and the 0007-seeded channel
		// it would have encrypted.
		await run(
			"insert into alert_channel (user_id, ntfy_url) values ('alice', 'https://ntfy.sh/alice-legacy')"
		);
		await run(
			"insert into notify_channel (user_id, kind, config_enc) values ('alice', 'ntfy', null), ('alice', 'resend', ?)",
			[sealedLegacy('alice', 'resend')]
		);
		await run(
			`insert into price_drop_delivery (watch_id, kind, user_id, target_pence) values
				('w1', 'ntfy', 'alice', 2000), ('w2', 'ntfy', 'alice', 2000), ('w1', 'resend', 'alice', 2000)`
		);

		await migrateDb(db, MIGRATIONS_FOLDER);

		expect(await ids('notify_channel', 'kind')).toEqual(['resend']);
		const delivered = await run(
			'select watch_id, kind from price_drop_delivery order by watch_id, kind'
		);
		expect(delivered.rows.map((row) => `${row.watch_id}/${row.kind}`)).toEqual(['w1/resend']);
		const legacy = await run("select name from sqlite_master where name = 'alert_channel'");
		expect(legacy.rows).toEqual([]);
		expect(await ids('watch')).toEqual(['w1', 'w2']);
		expect((await run('pragma foreign_key_check')).rows).toEqual([]);
	});

	it('multi-user DB rejected and untouched', async () => {
		await migrateDb(db, folderUpTo(8));
		await addUser('alice');
		await addUser('bob');
		await addWatch('wa', 'alice');
		await addWatch('wb', 'bob');
		await run(
			"insert into notify_channel (user_id, kind, config_enc) values ('alice', 'ntfy', ?), ('bob', 'ntfy', ?)",
			[sealedLegacy('alice', 'ntfy'), sealedLegacy('bob', 'ntfy')]
		);
		await run(
			"insert into price_drop_delivery (watch_id, kind, user_id, target_pence) values ('wa', 'ntfy', 'alice', 2000)"
		);
		const before = await dump();
		const appliedBefore = await lastApplied();
		expect(appliedBefore).toEqual({ count: 9, when: entry(8).when });

		let failure: unknown;
		await migrateDb(db, MIGRATIONS_FOLDER).catch((error: unknown) => (failure = error));

		// Refused on the channel key (two 'ntfy' rows), with nothing applied.
		expect(failure).toBeInstanceOf(Error);
		const cause = (failure as Error & { cause?: unknown }).cause;
		const message = `${(failure as Error).message} ${cause instanceof Error ? cause.message : ''}`;
		expect(message).toMatch(/UNIQUE constraint failed: __new_notify_channel\.kind/);
		expect(await lastApplied()).toEqual(appliedBefore);
		expect(await dump()).toEqual(before);
		expect((await columns('notify_channel')).map((c) => c.name)).toContain('user_id');
	});

	// One user's install at 0009: the watch rebuild keeps every watch's history.
	it('upgrade 0009->0010', async () => {
		await migrateDb(db, folderUpTo(9));
		expect(await lastApplied()).toMatchObject({ when: entry(9).when });

		await addUser('alice');
		for (const id of ['w1', 'w2', 'w3']) await addWatch(id, 'alice');
		for (const [id, watchId, at] of [
			['p1', 'w1', 1],
			['p2', 'w1', 2],
			['p3', 'w2', 1],
			['p4', 'w3', 1],
			['p5', 'w3', 2]
		] as const) {
			await run(
				'insert into price_point (id, watch_id, price_pence, checked_at) values (?, ?, 1999, ?)',
				[id, watchId, 1_700_000_000_000 + at]
			);
		}
		for (const [id, watchId] of [
			['f1', 'w1'],
			['f2', 'w3']
		] as const) {
			await run(
				"insert into check_failure (id, watch_id, reason, checked_at) values (?, ?, 'blocked', 1700000000000)",
				[id, watchId]
			);
		}
		await run("insert into notify_channel (kind, config_enc) values ('ntfy', 'v1:sealed')");
		await run(
			"insert into price_drop_delivery (watch_id, kind, target_pence) values ('w2', 'ntfy', 2000)"
		);

		await migrateDb(db, MIGRATIONS_FOLDER);

		expect(entry(10).tag).toBe('0010_single_user_watches');
		expect(entry(10).when).toBeGreaterThan(entry(9).when);
		expect(await lastApplied()).toEqual({ count: 11, when: entry(10).when });

		expect(await ids('watch')).toEqual(['w1', 'w2', 'w3']);
		expect(await ids('price_point')).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
		expect(await ids('check_failure')).toEqual(['f1', 'f2']);
		expect(await db.select().from(priceDropDelivery)).toEqual([
			{ watchId: 'w2', kind: 'ntfy', targetPence: 2000, deliveredAt: expect.any(Date) }
		]);
		const [w1] = await db.select().from(watch).where(eq(watch.id, 'w1'));
		expect(w1).toMatchObject({
			shop: 'amazon-uk',
			productId: 'w1',
			canonicalUrl: 'https://www.amazon.co.uk/dp/w1',
			targetPence: 2000
		});

		const names = (await columns('watch')).map((c) => c.name);
		expect(names).toContain('product_id');
		expect(names).not.toContain('user_id');
		expect((await run("select * from pragma_foreign_key_list('watch')")).rows).toEqual([]);
		const indexes = await run(
			"select name, sql from sqlite_master where type = 'index' and tbl_name = 'watch' and sql is not null"
		);
		expect(indexes.rows.map((row) => ({ ...row }))).toEqual([
			{
				name: 'watch_product_uq',
				sql: 'CREATE UNIQUE INDEX `watch_product_uq` ON `watch` (`shop`,`product_id`)'
			}
		]);
		expect((await run('pragma foreign_key_check')).rows).toEqual([]);
		expect((await tables()).filter((name) => name.startsWith('__new_'))).toEqual([]);
	});

	it('multi-user watches rejected and untouched', async () => {
		await migrateDb(db, folderUpTo(9));
		await addUser('alice');
		await addUser('bob');
		// The same product on two users' watchlists, each with history.
		await run(
			`insert into watch (id, user_id, shop, product_id, canonical_url) values
				('wa', 'alice', 'amazon-uk', 'B0X', 'https://www.amazon.co.uk/dp/B0X'),
				('wb', 'bob', 'amazon-uk', 'B0X', 'https://www.amazon.co.uk/dp/B0X')`
		);
		await run(
			`insert into price_point (id, watch_id, price_pence, checked_at) values
				('pa', 'wa', 1999, 1700000000000), ('pb', 'wb', 1999, 1700000000000)`
		);
		const before = await dump();
		const appliedBefore = await lastApplied();
		expect(appliedBefore).toEqual({ count: 10, when: entry(9).when });

		let failure: unknown;
		await migrateDb(db, MIGRATIONS_FOLDER).catch((error: unknown) => (failure = error));

		expect(failure).toBeInstanceOf(Error);
		const cause = (failure as Error & { cause?: unknown }).cause;
		const message = `${(failure as Error).message} ${cause instanceof Error ? cause.message : ''}`;
		expect(message).toMatch(/UNIQUE constraint failed: watch\.shop, watch\.product_id/);
		expect(await lastApplied()).toEqual(appliedBefore);
		expect(await dump()).toEqual(before);
		expect((await columns('watch')).map((c) => c.name)).toContain('user_id');
	});

	// c-5: what one server run stores, the next run on the same file reads back.
	it('restart keeps data', async () => {
		const key = randomBytes(32);
		const file = join(dir, 'app.db');
		await migrateDb(db, MIGRATIONS_FOLDER);
		await db.insert(watch).values({
			id: 'w1',
			shop: 'amazon-uk',
			productId: 'B0RESTART1',
			canonicalUrl: 'https://www.amazon.co.uk/dp/B0RESTART1',
			title: 'Restart Kettle',
			targetPence: 2000
		});
		await db.insert(pricePoint).values({
			id: 'p1',
			watchId: 'w1',
			pricePence: 1999,
			checkedAt: new Date(1_700_000_000_000)
		});
		expect(await saveChannel(db, key, 'ntfy', { topic: 'https://ntfy.sh/restart-topic' })).toEqual({
			ok: true
		});

		// The server stops; a new one opens the same file and migrates on start.
		db.$client.close();
		db = createDb(`file:${file}`);
		await migrateDb(db, MIGRATIONS_FOLDER);

		expect(await listWatches(db)).toEqual([
			expect.objectContaining({ id: 'w1', title: 'Restart Kettle', targetPence: 2000 })
		]);
		expect(await priceHistory(db, 'w1')).toEqual([
			{ pricePence: 1999, checkedAt: new Date(1_700_000_000_000) }
		]);
		expect(await listChannels(db, key)).toEqual({
			ntfy: expect.objectContaining({
				enabled: true,
				unreadable: false,
				view: { topic: 'https://ntfy.sh/restart-topic', tokenSet: false }
			})
		});
	});

	it('idempotent restart', async () => {
		const file = join(dir, 'app.db');
		await migrateDb(db, MIGRATIONS_FOLDER);
		const applied = await lastApplied();
		expect(applied.count).toBe(journal.entries.length);
		await db.insert(watch).values({
			id: 'w1',
			shop: 'amazon-uk',
			productId: 'B0AGAIN001',
			canonicalUrl: 'https://www.amazon.co.uk/dp/B0AGAIN001'
		});
		await db
			.insert(pricePoint)
			.values({ id: 'p1', watchId: 'w1', pricePence: 500, checkedAt: new Date(1_700_000_000_000) });
		await db.insert(notifyChannel).values({ kind: 'ntfy', configEnc: 'v1:sealed' });
		const before = await dump();

		db.$client.close();
		db = createDb(`file:${file}`);
		await migrateDb(db, MIGRATIONS_FOLDER);

		expect(await lastApplied()).toEqual(applied);
		expect(await dump()).toEqual(before);
	});
});
