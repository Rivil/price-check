import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrationsFolder } from '../db/migrate.ts';
import { createTestDb, MIGRATIONS_FOLDER, type TestDb } from './test-db.ts';

let open: TestDb[] = [];

async function fresh() {
	const t = await createTestDb();
	open.push(t);
	return t;
}

afterEach(() => {
	for (const t of open) {
		if (!t.db.$client.closed) t.dispose();
	}
	open = [];
});

/** Read from the cwd-resolved folder, independently of the harness's own path. */
function journalWhens(): number[] {
	const journal = JSON.parse(
		readFileSync(join(migrationsFolder(), 'meta', '_journal.json'), 'utf8')
	) as { entries: { when: number }[] };
	return journal.entries.map((entry) => entry.when);
}

describe('createTestDb', () => {
	it('gives every call its own file', async () => {
		const a = await fresh();
		const b = await fresh();

		expect(a.file).not.toBe(b.file);
		expect(a.dir).not.toBe(b.dir);
		expect(a.url).toBe(`file:${a.file}`);

		await a.db.$client.execute('create table probe (x integer)');
		const inB = await b.db.$client.execute(
			"select count(*) as n from sqlite_master where name = 'probe'"
		);
		expect(Number(inB.rows[0].n)).toBe(0);
	});

	it('fresh harness DB has __drizzle_migrations row count === journal entry count', async () => {
		const { db } = await fresh();
		const whens = journalWhens();

		const applied = await db.$client.execute(
			'select created_at from __drizzle_migrations order by id'
		);

		expect(whens.length).toBeGreaterThan(0);
		expect(applied.rows).toHaveLength(whens.length);
		expect(applied.rows.map((row) => Number(row.created_at))).toEqual(whens);
		expect(MIGRATIONS_FOLDER).toBe(migrationsFolder());
	});

	it('dispose closes the client and removes the temp dir', async () => {
		const t = await fresh();
		expect(existsSync(t.file)).toBe(true);

		t.dispose();

		await expect(t.db.$client.execute('select 1')).rejects.toThrow(/closed/i);
		if (process.platform !== 'win32') expect(existsSync(t.dir)).toBe(false);
	});
});
