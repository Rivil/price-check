import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, MIGRATIONS_FOLDER, type TestDb } from '../testing/test-db.ts';
import { createDb, type Db } from './client.ts';
import { migrateDb } from './migrate.ts';
import { checkFailure, watch } from './schema.ts';
import { removeTempDir } from '../testing/temp-dir.ts';

const CHECKED_AT = new Date(1_700_000_000_000);
const CREATED_AT = new Date(1_690_000_000_000);

describe('check_failure table', () => {
	let h: TestDb;

	beforeEach(async () => {
		h = await createTestDb();
		for (const id of ['w1', 'w2']) {
			await h.db.insert(watch).values({
				id,
				shop: 'amazon-uk',
				productId: `B0${id.toUpperCase()}000000`.slice(0, 10),
				canonicalUrl: `https://www.amazon.co.uk/dp/${id}`
			});
		}
	});
	afterEach(() => h.dispose());

	const failure = (id: string, watchId: string) => ({
		id,
		watchId,
		reason: 'blocked',
		message: 'captcha page',
		checkedAt: CHECKED_AT
	});

	it('cascade', async () => {
		await h.db
			.insert(checkFailure)
			.values([failure('f1', 'w1'), failure('f2', 'w1'), failure('f3', 'w2')]);

		await h.db.delete(watch).where(eq(watch.id, 'w1'));
		const left = await h.db.select({ id: checkFailure.id }).from(checkFailure);
		expect(left.map((row) => row.id)).toEqual(['f3']);

		await h.db.delete(watch).where(eq(watch.id, 'w2'));
		expect(await h.db.select().from(checkFailure)).toEqual([]);
	});

	it('required', async () => {
		// Drizzle wraps the driver error; SQLite's own message is on the cause.
		for (const [column, values] of [
			['reason', { id: 'f1', watchId: 'w1', checkedAt: CHECKED_AT }],
			['checked_at', { id: 'f2', watchId: 'w1', reason: 'blocked' }]
		] as const) {
			await expect(
				h.db.insert(checkFailure).values(values as unknown as typeof checkFailure.$inferInsert),
				column
			).rejects.toMatchObject({
				cause: {
					message: expect.stringMatching(`NOT NULL constraint failed: check_failure.${column}`)
				}
			});
		}
	});
});

describe('0006 backfill', () => {
	let dir: string;
	let db: Db;

	// A database as it stood before this migration: the real folder, cut off at 0005.
	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), 'apc-backfill-'));
		const folder = join(dir, 'drizzle');
		cpSync(MIGRATIONS_FOLDER, folder, { recursive: true });
		const journalFile = join(folder, 'meta', '_journal.json');
		const journal = JSON.parse(readFileSync(journalFile, 'utf8'));
		journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= 5);
		writeFileSync(journalFile, JSON.stringify(journal));

		db = createDb(`file:${join(dir, 'app.db')}`);
		await migrateDb(db, folder);
		// Raw SQL: the 0005 shape, whatever the schema says now.
		await db.$client.execute(
			"insert into user (id, name, email) values ('u1', 'Alice', 'alice@example.test')"
		);
	});
	afterEach(() => {
		db.$client.close();
		removeTempDir(dir);
	});

	type Fields = { lastCheckedAt?: Date; lastCheckReason?: string; lastCheckMessage?: string };
	const addWatch = (id: string, values: Fields) =>
		db.$client.execute({
			sql: `insert into watch (id, user_id, shop, product_id, canonical_url, created_at,
					last_checked_at, last_check_reason, last_check_message)
				values (?, 'u1', 'amazon-uk', ?, ?, ?, ?, ?, ?)`,
			args: [
				id,
				id,
				`https://www.amazon.co.uk/dp/${id}`,
				CREATED_AT.getTime(),
				values.lastCheckedAt?.getTime() ?? null,
				values.lastCheckReason ?? null,
				values.lastCheckMessage ?? null
			]
		});

	const migrateToLatest = () => migrateDb(db, MIGRATIONS_FOLDER);

	it('backfill', async () => {
		await addWatch('failing', {
			lastCheckedAt: CHECKED_AT,
			lastCheckReason: 'blocked',
			lastCheckMessage: 'captcha page'
		});
		await addWatch('healthy', { lastCheckedAt: CHECKED_AT });

		await migrateToLatest();

		expect(await db.select().from(checkFailure)).toEqual([
			{
				id: expect.any(String),
				watchId: 'failing',
				reason: 'blocked',
				message: 'captcha page',
				checkedAt: CHECKED_AT
			}
		]);
	});

	it('backfill null message', async () => {
		await addWatch('failing', { lastCheckedAt: CHECKED_AT, lastCheckReason: 'blocked' });

		await migrateToLatest();

		expect(await db.select().from(checkFailure)).toEqual([
			expect.objectContaining({ watchId: 'failing', reason: 'blocked', message: null })
		]);
	});

	it('backfill null time', async () => {
		await addWatch('failing', { lastCheckReason: 'blocked' });

		await migrateToLatest();

		expect(await db.select().from(checkFailure)).toEqual([
			expect.objectContaining({ watchId: 'failing', checkedAt: CREATED_AT })
		]);
	});

	it('no re-backfill', async () => {
		for (const id of ['failing-1', 'failing-2']) {
			await addWatch(id, { lastCheckedAt: CHECKED_AT, lastCheckReason: 'blocked' });
		}

		await migrateToLatest();
		const first = await db.select().from(checkFailure);
		expect(new Set(first.map((row) => row.id)).size).toBe(2);

		await migrateToLatest();
		expect(await db.select().from(checkFailure)).toEqual(first);
	});
});
