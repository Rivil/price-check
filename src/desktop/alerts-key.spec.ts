// Assertions compare keys and file contents as booleans or sha256 hashes, so a
// failure never prints key material (even these throwaway test keys).
import { createHash, randomBytes } from 'node:crypto';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	AlertsKeyError,
	channelAad,
	decryptSecret,
	encryptSecret,
	parseAlertsKey
} from '#lib/server/alerts/crypto.ts';
import { removeTempDir } from '#lib/server/testing/temp-dir.ts';
import { loadOrCreateAlertsKey } from './alerts-key.ts';

// Runs once, just before the key's link(): lets a test create the key file in the
// window between the existence check and the write.
const hooks = vi.hoisted(() => ({
	beforeLink: undefined as undefined | ((dest: string) => void)
}));

vi.mock('node:fs/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs/promises')>();
	return {
		...actual,
		link: async (...args: Parameters<typeof actual.link>) => {
			const hook = hooks.beforeLink;
			hooks.beforeLink = undefined;
			hook?.(String(args[1]));
			return actual.link(...args);
		}
	};
});

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const fileHash = (file: string) => sha256(readFileSync(file));
const tempLeftovers = (dir: string) => readdirSync(dir).filter((n) => n.includes('.tmp-'));

let root: string;
let dir: string;
let keyFile: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'apc-key-'));
	dir = join(root, 'price-check');
	keyFile = join(dir, 'alerts.key');
	hooks.beforeLink = undefined;
});

afterEach(() => {
	hooks.beforeLink = undefined;
	removeTempDir(root);
});

async function rejection(promise: Promise<unknown>): Promise<Error> {
	try {
		await promise;
	} catch (error) {
		return error as Error;
	}
	throw new Error('expected a rejection');
}

describe('loadOrCreateAlertsKey', () => {
	it('creates a key parseAlertsKey accepts on an empty dir', async () => {
		const key = await loadOrCreateAlertsKey(keyFile);

		expect(key.length).toBe(32);
		const parsed = parseAlertsKey(readFileSync(keyFile, 'utf8'));
		expect(parsed.equals(key)).toBe(true);
		expect(statSync(keyFile).size).toBe(44);
		expect(tempLeftovers(dir)).toEqual([]);
	});

	it('creates a missing nested userData dir', async () => {
		const nested = join(root, 'a', 'b', 'c', 'price-check', 'alerts.key');

		const key = await loadOrCreateAlertsKey(nested);

		expect(key.length).toBe(32);
		expect(existsSync(nested)).toBe(true);
	});

	it('never regenerated: a relaunch returns the same key and leaves the file unchanged', async () => {
		const first = await loadOrCreateAlertsKey(keyFile);
		const before = fileHash(keyFile);

		const second = await loadOrCreateAlertsKey(keyFile);
		const third = await loadOrCreateAlertsKey(keyFile);

		expect(second.equals(first)).toBe(true);
		expect(third.equals(first)).toBe(true);
		expect(fileHash(keyFile)).toBe(before);
	});

	it('never regenerated: a credential sealed under launch 1 opens under launch 2 (c-2)', async () => {
		const aad = channelAad('ntfy');
		const sealed = encryptSecret(await loadOrCreateAlertsKey(keyFile), 'tk_secret-token', aad);

		const relaunched = await loadOrCreateAlertsKey(keyFile);

		expect(decryptSecret(relaunched, sealed, aad)).toEqual({
			ok: true,
			plaintext: 'tk_secret-token'
		});
	});

	it.skipIf(process.platform === 'win32')('creates the key file with mode 0600', async () => {
		await loadOrCreateAlertsKey(keyFile);

		expect(statSync(keyFile).mode & 0o777).toBe(0o600);
	});

	const valid = randomBytes(32).toString('base64');
	const badFiles: [string, string][] = [
		['empty', ''],
		['whitespace only', ' \n'],
		['truncated', valid.slice(0, 20)],
		['non-base64', 'this is not base64!!'],
		['31 bytes decoded', randomBytes(31).toString('base64')],
		['33 bytes decoded', randomBytes(33).toString('base64')]
	];

	it.each(badFiles)(
		'bad key refused (%s): throws naming the path, file untouched',
		async (_, contents) => {
			mkdirSync(dir, { recursive: true });
			writeFileSync(keyFile, contents);
			const before = fileHash(keyFile);

			const error = await rejection(loadOrCreateAlertsKey(keyFile));

			expect(error).toBeInstanceOf(AlertsKeyError);
			expect(error.message.includes(keyFile)).toBe(true);
			if (contents.trim() !== '') {
				expect(error.message.includes(contents.trim())).toBe(false);
				expect(String(error.stack).includes(contents.trim())).toBe(false);
			}
			expect(fileHash(keyFile)).toBe(before);
			expect(tempLeftovers(dir)).toEqual([]);
		}
	);

	it('refuses a key path that is a directory instead of replacing it', async () => {
		mkdirSync(keyFile, { recursive: true });

		await expect(loadOrCreateAlertsKey(keyFile)).rejects.toThrow();

		expect(statSync(keyFile).isDirectory()).toBe(true);
	});

	it('concurrent first launches agree on one key', async () => {
		const keys = await Promise.all(Array.from({ length: 8 }, () => loadOrCreateAlertsKey(keyFile)));

		const hashes = new Set(keys.map((k) => sha256(k)));
		expect(hashes.size).toBe(1);
		expect(parseAlertsKey(readFileSync(keyFile, 'utf8')).equals(keys[0])).toBe(true);
		expect(tempLeftovers(dir)).toEqual([]);
	});

	it('a key created between the existence check and the write is kept, not overwritten', async () => {
		const competitor = randomBytes(32).toString('base64');
		hooks.beforeLink = (dest) => writeFileSync(dest, competitor);

		const key = await loadOrCreateAlertsKey(keyFile);

		expect(sha256(key.toString('base64'))).toBe(sha256(competitor));
		expect(fileHash(keyFile)).toBe(sha256(competitor));
		expect(tempLeftovers(dir)).toEqual([]);
	});

	it('a damaged key created by a competitor mid-write is refused, not overwritten', async () => {
		hooks.beforeLink = (dest) => writeFileSync(dest, 'half-writ');

		const error = await rejection(loadOrCreateAlertsKey(keyFile));

		expect(error).toBeInstanceOf(AlertsKeyError);
		expect(error.message.includes(keyFile)).toBe(true);
		expect(readFileSync(keyFile, 'utf8')).toBe('half-writ');
	});

	it('ignores a leftover temp file from an interrupted write', async () => {
		mkdirSync(dir, { recursive: true });
		const leftoverKey = randomBytes(32).toString('base64');
		const leftover = join(dir, 'alerts.key.tmp-999-deadbeef0000');
		const garbage = join(dir, 'alerts.key.tmp-1-000000000000');
		writeFileSync(leftover, leftoverKey);
		writeFileSync(garbage, 'garbage');

		const key = await loadOrCreateAlertsKey(keyFile);

		expect(sha256(key.toString('base64')) === sha256(leftoverKey)).toBe(false);
		expect(parseAlertsKey(readFileSync(keyFile, 'utf8')).equals(key)).toBe(true);
		expect(existsSync(leftover)).toBe(true);
		expect(existsSync(garbage)).toBe(true);
	});
});
