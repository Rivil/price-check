import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DrizzleQueryError } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, type Db } from './db/client.ts';
import { migrateDb } from './db/migrate.ts';
import { healthResponse } from './health.ts';
import { MIGRATIONS_FOLDER } from './testing/auth-harness.ts';

let dir: string;
let opened: Db[];
let logged: ReturnType<typeof vi.spyOn>;
let files = 0;

function open(file: string) {
	const db = createDb(`file:${file}`);
	opened.push(db);
	return db;
}

function freshFile() {
	files += 1;
	return join(dir, `app-${files}.db`);
}

async function migrated(file = freshFile()) {
	const db = open(file);
	await migrateDb(db, MIGRATIONS_FOLDER);
	return db;
}

/** A Db whose first read throws: real SQLite errors carry no planted text. */
function failingDb(thrown: unknown) {
	return {
		select() {
			throw thrown;
		}
	} as unknown as Db;
}

async function expectUnavailable(response: Response) {
	expect(response.status).toBe(503);
	expect(response.headers.get('cache-control')).toBe('no-store');
	expect(await response.text()).toBe('{"status":"unavailable"}');
}

function logLines() {
	return logged.mock.calls.map((call: unknown[]) => call.join(' '));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'apc-health-'));
	opened = [];
	logged = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	for (const db of opened) db.$client.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('healthResponse', () => {
	it('healthy', async () => {
		const response = await healthResponse(await migrated());

		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(await response.text()).toBe('{"status":"ok"}');
		expect(logged).not.toHaveBeenCalled();
	});

	it('unreadable', async () => {
		await expectUnavailable(await healthResponse(open(freshFile())));

		const garbage = freshFile();
		writeFileSync(garbage, 'this is not a database\n'.repeat(200));
		await expectUnavailable(await healthResponse(open(garbage)));
	});

	it('every table', async () => {
		const listed = await (
			await migrated()
		).$client.execute(
			"select name from sqlite_master where type = 'table' " +
				"and name != '__drizzle_migrations' and name not like 'sqlite_%'"
		);
		const tables = listed.rows.map((row) => String(row.name));
		expect(tables).toContain('watch');

		for (const table of tables) {
			const db = await migrated();
			await db.$client.execute(`drop table "${table}"`);

			await expectUnavailable(await healthResponse(db));
		}
	});

	it('lock clears', async () => {
		const file = freshFile();
		const db = await migrated(file);
		const locker = open(file);
		await locker.$client.execute('begin exclusive');

		const started = Date.now();
		const released = sleep(700).then(() => locker.$client.execute('commit'));
		const response = await healthResponse(db);
		const elapsed = Date.now() - started;
		await released;

		expect(response.status).toBe(200);
		// An answer before the release means the read never met the lock.
		expect(elapsed).toBeGreaterThanOrEqual(690);
		expect(logged).not.toHaveBeenCalled();
	});

	it('lock outlasts retry', async () => {
		const file = freshFile();
		const db = await migrated(file);
		const locker = open(file);
		await locker.$client.execute('begin exclusive');

		const started = Date.now();
		const response = await healthResponse(db);
		const elapsed = Date.now() - started;
		await locker.$client.execute('commit');

		await expectUnavailable(response);
		expect(elapsed).toBeGreaterThanOrEqual(800);
		expect(elapsed).toBeLessThan(3000);
		expect(logLines()).toEqual(['[health] read failed: DrizzleQueryError SQLITE_BUSY']);
	});

	it('retry deadline', async () => {
		vi.useFakeTimers();
		const db = failingDb(
			new DrizzleQueryError(
				'select 1',
				[],
				Object.assign(new Error('locked'), { code: 'SQLITE_BUSY' })
			)
		);
		const select = vi.spyOn(db, 'select');

		const started = Date.now();
		const answered = healthResponse(db).then((response) => ({
			response,
			elapsed: Date.now() - started
		}));
		await vi.advanceTimersByTimeAsync(2000);
		const { response, elapsed } = await answered;

		await expectUnavailable(response);
		// One read at the start and one every 100ms, the last exactly on the deadline.
		expect(select).toHaveBeenCalledTimes(11);
		expect(elapsed).toBe(1000);
	});

	it('no retry', async () => {
		vi.useFakeTimers();
		const coded = new DrizzleQueryError(
			'select 1',
			[],
			Object.assign(new Error('disk'), { code: 'SQLITE_IOERR' })
		);

		// A scheduled retry would never fire, so these would hang rather than answer.
		await expectUnavailable(await healthResponse(failingDb(new Error('boom'))));
		await expectUnavailable(await healthResponse(failingDb(coded)));

		expect(vi.getTimerCount()).toBe(0);
	});

	it('log line', async () => {
		const garbage = freshFile();
		writeFileSync(garbage, 'this is not a database\n'.repeat(200));

		await healthResponse(open(garbage));

		expect(logLines()).toEqual(['[health] read failed: DrizzleQueryError SQLITE_NOTADB']);
	});

	it('no code', async () => {
		const cases: [unknown, string][] = [
			[new Error('boom'), 'Error'],
			[new TypeError('boom'), 'TypeError'],
			[new Error('boom', { cause: 'a string' }), 'Error'],
			[new Error('boom', { cause: null }), 'Error'],
			[new Error('boom', { cause: { code: 42 } }), 'Error'],
			// Coerces to a string the pattern accepts, so only the type check stops it.
			[new Error('boom', { cause: { code: ['SQLITE_BUSY'] } }), 'Error'],
			['a thrown string', 'string'],
			[null, 'object']
		];

		for (const [thrown, type] of cases) {
			logged.mockClear();

			await expectUnavailable(await healthResponse(failingDb(thrown)));

			expect(logLines()).toEqual([`[health] read failed: ${type}`]);
		}
	});

	it('no leak', async () => {
		const path = '/data/secret/app.db';
		const sql = 'select "token" from "alert_channel"';
		const cases = [
			new Error(`${sql}\nparams: ${path}`),
			new DrizzleQueryError(
				sql,
				[path],
				Object.assign(new Error(`${sql} ${path}`), { code: 'SQLITE_IOERR' })
			),
			// A code that isn't one: only a real SQLite code reaches the log.
			new Error('boom', { cause: { code: `SQLITE_ ${path}` } }),
			// A real code with text either side: one for each end of the pattern.
			new Error('boom', { cause: { code: `${path} SQLITE_BUSY` } }),
			new Error('boom', { cause: { code: `SQLITE_BUSY ${path}` } })
		];

		for (const thrown of cases) {
			logged.mockClear();

			const response = await healthResponse(failingDb(thrown));
			const text = [await response.text(), ...logLines()].join('\n');

			expect(logLines()).toHaveLength(1);
			expect(text).not.toContain('secret');
			expect(text).not.toContain('alert_channel');
			expect(text).not.toContain('select');
		}
	});
});
