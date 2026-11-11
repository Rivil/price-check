import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createAuthHarness, MIGRATIONS_FOLDER, type AuthHarness } from '../testing/auth-harness.ts';
import { createDb } from './client.ts';
import { migrateDb } from './migrate.ts';
import { user, watch } from './schema.ts';
import { removeTempDir } from '../testing/temp-dir.ts';

let h: AuthHarness;
let alice: string;
let bob: string;

beforeEach(async () => {
	h = await createAuthHarness();
	alice = (await h.createUser({ email: 'alice@example.test' })).id;
	bob = (await h.createUser({ email: 'bob@example.test' })).id;
});
afterEach(() => h.cleanup());

function row(userId: string, id: string, productId = 'B0PLAINASN') {
	return {
		id,
		userId,
		shop: 'amazon-uk',
		productId,
		canonicalUrl: `https://www.amazon.co.uk/dp/${productId}`
	};
}

describe('watch table', () => {
	it('one watch per product per user', async () => {
		await h.db.insert(watch).values(row(alice, 'w1'));

		// Drizzle wraps the driver error; SQLite's own message is on the cause.
		await expect(h.db.insert(watch).values(row(alice, 'w2'))).rejects.toMatchObject({
			cause: {
				message: expect.stringMatching(
					/UNIQUE constraint failed: watch\.user_id, watch\.shop, watch\.product_id/
				)
			}
		});
		// Same ASIN, different shop id: a different product.
		await h.db.insert(watch).values({ ...row(alice, 'w3'), shop: 'other-shop' });
	});

	it('the same product for another user', async () => {
		await h.db.insert(watch).values(row(alice, 'w1'));
		await h.db.insert(watch).values(row(bob, 'w2'));

		const rows = await h.db.select({ id: watch.id }).from(watch);
		expect(rows.map((r) => r.id).sort()).toEqual(['w1', 'w2']);
	});

	it('a failed watch has no title, image or price', async () => {
		await h.db.insert(watch).values({
			...row(alice, 'w1'),
			lastCheckedAt: new Date(1_700_000_000_000),
			lastCheckReason: 'blocked',
			lastCheckMessage: 'captcha page'
		});

		const [stored] = await h.db.select().from(watch).where(eq(watch.id, 'w1'));
		expect(stored).toMatchObject({
			title: null,
			imageUrl: null,
			pricePence: null,
			targetPence: null,
			lastCheckReason: 'blocked',
			lastCheckedAt: new Date(1_700_000_000_000)
		});
		expect(stored.createdAt).toBeInstanceOf(Date);
	});

	it('deleting a user deletes their watches', async () => {
		await h.db
			.insert(watch)
			.values([row(alice, 'w1'), row(alice, 'w2', 'B0OTHERASN'), row(bob, 'w3')]);

		await h.db.delete(user).where(eq(user.id, alice));

		const rows = await h.db.select({ id: watch.id }).from(watch);
		expect(rows.map((r) => r.id)).toEqual(['w3']);
	});
});

describe('0008 drop alerted_at', () => {
	it('retired', async () => {
		const columns = await h.db.$client.execute("select name from pragma_table_info('watch')");
		const names = columns.rows.map((r) => String(r.name));
		expect(names).toContain('target_pence');
		expect(names).not.toContain('alerted_at');
	});

	// A table rebuild would DROP TABLE watch, and with foreign keys on that cascades
	// every price point, failure and delivery row away.
	it('history survives 0008', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'apc-0008-'));
		const db = createDb(`file:${join(dir, 'app.db')}`);
		try {
			const folder = join(dir, 'drizzle');
			cpSync(MIGRATIONS_FOLDER, folder, { recursive: true });
			const journalFile = join(folder, 'meta', '_journal.json');
			const journal = JSON.parse(readFileSync(journalFile, 'utf8'));
			journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= 7);
			writeFileSync(journalFile, JSON.stringify(journal));
			await migrateDb(db, folder);

			const run = (sql: string) => db.$client.execute(sql);
			await run(`insert into user (id, name, email) values ('u1', 'Alice', 'alice@example.test')`);
			await run(`insert into watch (id, user_id, shop, product_id, canonical_url, target_pence, alerted_at)
				values ('w1', 'u1', 'amazon-uk', 'B0W1', 'https://www.amazon.co.uk/dp/B0W1', 2000, 1700000000000)`);
			await run(`insert into price_point (id, watch_id, price_pence, checked_at)
				values ('p1', 'w1', 1999, 1700000000000)`);
			await run(`insert into check_failure (id, watch_id, reason, checked_at)
				values ('f1', 'w1', 'blocked', 1700000000000)`);
			await run(`insert into notify_channel (user_id, kind) values ('u1', 'ntfy')`);
			await run(`insert into price_drop_delivery (watch_id, kind, user_id, target_pence)
				values ('w1', 'ntfy', 'u1', 2000)`);

			await migrateDb(db, MIGRATIONS_FOLDER);

			const count = async (table: string) =>
				Number((await run(`select count(*) as n from ${table}`)).rows[0].n);
			expect(await count('watch')).toBe(1);
			expect(await count('price_point')).toBe(1);
			expect(await count('check_failure')).toBe(1);
			expect(await count('price_drop_delivery')).toBe(1);
			const columns = await run("select name from pragma_table_info('watch')");
			expect(columns.rows.map((r) => String(r.name))).not.toContain('alerted_at');
		} finally {
			db.$client.close();
			removeTempDir(dir);
		}
	});
});
