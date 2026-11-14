import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseAlertsKey } from '#lib/server/alerts/crypto.ts';
import { createDb } from '#lib/server/db/client.ts';
import { migrateDb } from '#lib/server/db/migrate.ts';
import { MIGRATIONS_FOLDER } from '#lib/server/testing/test-db.ts';
import { removeTempDir } from '#lib/server/testing/temp-dir.ts';
import { desktopPaths } from './app-paths.ts';
import { serverEnv } from './server-env.ts';

const DB_FILE = join(tmpdir(), 'price-check', 'price-check.db');

function input() {
	return { dbFile: DB_FILE, key: randomBytes(32) };
}

describe('serverEnv', () => {
	it.each(['ORIGIN', 'HOST_HEADER', 'PORT_HEADER', 'ADDRESS_HEADER', 'Origin', 'host_header'])(
		'drops inherited %s',
		(name) => {
			const env = serverEnv({ [name]: 'https://evil.example', PATH: '/bin' }, input());

			expect(name in env).toBe(false);
			expect(env.PATH).toBe('/bin');
		}
	);

	it("sets PROTOCOL_HEADER to 'x-forwarded-proto' over an inherited one", () => {
		const env = serverEnv({ PROTOCOL_HEADER: 'x-evil-proto' }, input());

		expect(env.PROTOCOL_HEADER).toBe('x-forwarded-proto');
	});

	it("owns DATABASE_URL and ALERTS_ENCRYPTION_KEY over the user's shell", () => {
		const own = input();
		const env = serverEnv(
			{
				DATABASE_URL: 'file:/elsewhere/other.db',
				ALERTS_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
				database_url: 'file:/elsewhere/lower.db'
			},
			own
		);

		expect(env.DATABASE_URL).toBe(`file:${DB_FILE}`);
		expect(parseAlertsKey(env.ALERTS_ENCRYPTION_KEY).equals(own.key)).toBe(true);
		expect('database_url' in env).toBe(false);
	});

	it('passes SCHEDULER_DISABLED and CHECK_INTERVAL_HOURS through', () => {
		const env = serverEnv({ SCHEDULER_DISABLED: '1', CHECK_INTERVAL_HOURS: '12' }, input());

		expect(env.SCHEDULER_DISABLED).toBe('1');
		expect(env.CHECK_INTERVAL_HOURS).toBe('12');
	});

	it('leaves out undefined inherited values and never mutates the input', () => {
		const inherited: NodeJS.ProcessEnv = { HOME: '/home/u', EMPTY: undefined, ORIGIN: 'x' };

		const env = serverEnv(inherited, input());

		expect('EMPTY' in env).toBe(false);
		expect(env.HOME).toBe('/home/u');
		expect(inherited).toEqual({ HOME: '/home/u', EMPTY: undefined, ORIGIN: 'x' });
	});
});

describe('serverEnv DATABASE_URL', () => {
	let root: string | undefined;
	const startCwd = process.cwd();

	afterEach(() => {
		process.chdir(startCwd);
		if (root) removeTempDir(root);
		root = undefined;
	});

	it('awkward path: createDb + migrateDb create exactly <dir>/price-check.db', async () => {
		root = mkdtempSync(join(tmpdir(), 'apc-env-'));
		const userData = join(root, 'Application Support Zoë #1 50%');
		mkdirSync(userData);
		const cwd = join(root, 'cwd');
		mkdirSync(cwd);
		process.chdir(cwd);
		const { dbFile } = desktopPaths(userData);

		const env = serverEnv({}, { dbFile, key: randomBytes(32) });
		const db = createDb(env.DATABASE_URL);
		try {
			await migrateDb(db, MIGRATIONS_FOLDER);
		} finally {
			db.$client.close();
		}

		expect(existsSync(join(userData, 'price-check.db'))).toBe(true);
		expect(readdirSync(cwd)).toEqual([]);
		expect(readdirSync(root).sort()).toEqual(['Application Support Zoë #1 50%', 'cwd']);
	});
});
