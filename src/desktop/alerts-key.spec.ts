// Assertions compare keys and file contents as booleans or sha256 hashes, so a
// failure never prints key material (even these throwaway test keys).
//
// safeStorage is a fake (fakeStorage): a reversible XOR behind a sentinel prefix,
// so a wrapped file can be checked without an OS keychain, and every plaintext and
// ciphertext it saw is recorded for the leak checks.
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
import { loadOrCreateAlertsKey, WRAPPED_PREFIX, type SafeStorage } from './alerts-key.ts';

// beforeLink runs once, just before the key's link(): lets a test create the key
// file in the window between the existence check and the write. beforeRename runs
// once before a migration's rename() and may throw to fail it; beforeRm likewise
// before the next rm().
const hooks = vi.hoisted(() => ({
	beforeLink: undefined as undefined | ((dest: string) => void),
	beforeRename: undefined as undefined | ((dest: string) => void),
	beforeRm: undefined as undefined | ((path: string) => void)
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
		},
		rename: async (...args: Parameters<typeof actual.rename>) => {
			const hook = hooks.beforeRename;
			hooks.beforeRename = undefined;
			hook?.(String(args[1]));
			return actual.rename(...args);
		},
		rm: async (...args: Parameters<typeof actual.rm>) => {
			const hook = hooks.beforeRm;
			hooks.beforeRm = undefined;
			hook?.(String(args[0]));
			return actual.rm(...args);
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
	hooks.beforeRename = undefined;
	hooks.beforeRm = undefined;
});

afterEach(() => {
	hooks.beforeLink = undefined;
	hooks.beforeRename = undefined;
	hooks.beforeRm = undefined;
	vi.restoreAllMocks();
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

/** Marks every fake ciphertext, so a leak of one is easy to spot. */
const SENTINEL = 'FAKE-CT-SENTINEL-41c7';

type FakeStorage = SafeStorage & {
	/** Every plaintext encryptString got and the base64 of every ciphertext it made. */
	seen: string[];
};

/** A safeStorage stand-in; `over` replaces any of its methods. */
function fakeStorage(over: Partial<SafeStorage> = {}): FakeStorage {
	const seen: string[] = [];
	const xor = (data: Buffer) => Buffer.from(data.map((b) => b ^ 0x5a));
	const fake: FakeStorage = {
		seen,
		isEncryptionAvailable: () => true,
		encryptString(plainText) {
			const encrypted = Buffer.concat([Buffer.from(SENTINEL), xor(Buffer.from(plainText))]);
			seen.push(plainText, encrypted.toString('base64'));
			return encrypted;
		},
		decryptString(encrypted) {
			const head = encrypted.subarray(0, SENTINEL.length).toString();
			if (head !== SENTINEL) throw new Error(`fake: foreign ${encrypted.toString('base64')}`);
			return xor(encrypted.subarray(SENTINEL.length)).toString();
		},
		getSelectedStorageBackend: () => 'gnome_libsecret',
		...over
	};
	return fake;
}

/** The key a wrapped file holds, decrypted with `storage`. */
function unwrapped(storage: SafeStorage, text: string): Buffer {
	const payload = Buffer.from(text.slice(WRAPPED_PREFIX.length), 'base64');
	return parseAlertsKey(storage.decryptString(payload));
}

const isRawKey = (text: string) => {
	try {
		parseAlertsKey(text);
		return true;
	} catch {
		return false;
	}
};

/** A v0.1.5 key file: raw base64 of 32 random bytes at 0600. Returns the key. */
function seedRawKey(): Buffer {
	const key = randomBytes(32);
	mkdirSync(dir, { recursive: true });
	writeFileSync(keyFile, key.toString('base64'), { mode: 0o600 });
	return key;
}

const posixOnly = it.skipIf(process.platform === 'win32');

describe('loadOrCreateAlertsKey with safeStorage (c-24, c-25)', () => {
	it.each(['darwin', 'win32'] as const)('new key wrapped (%s)', async (platform) => {
		const storage = fakeStorage();

		const key = await loadOrCreateAlertsKey(keyFile, { safeStorage: storage, platform });

		const text = readFileSync(keyFile, 'utf8');
		expect(text.startsWith(WRAPPED_PREFIX)).toBe(true);
		expect(isRawKey(text)).toBe(false);
		expect(unwrapped(storage, text).equals(key)).toBe(true);
		expect(tempLeftovers(dir)).toEqual([]);
		if (process.platform !== 'win32') expect(statSync(keyFile).mode & 0o777).toBe(0o600);

		const before = fileHash(keyFile);
		const relaunched = await loadOrCreateAlertsKey(keyFile, { safeStorage: storage, platform });
		expect(relaunched.equals(key)).toBe(true);
		expect(fileHash(keyFile)).toBe(before);
	});

	const linuxBackends: [string, boolean][] = [
		['basic_text', false],
		['unknown', false],
		['gnome_libsecret', true],
		['kwallet', true],
		['kwallet5', true],
		['kwallet6', true]
	];

	it.each(linuxBackends)(
		'linux %s: a new key is wrapped only on a keyring (%s)',
		async (backend, wraps) => {
			const storage = fakeStorage({ getSelectedStorageBackend: () => backend });

			const key = await loadOrCreateAlertsKey(keyFile, { safeStorage: storage, platform: 'linux' });

			const text = readFileSync(keyFile, 'utf8');
			expect(text.startsWith(WRAPPED_PREFIX)).toBe(wraps);
			if (wraps) {
				expect(unwrapped(storage, text).equals(key)).toBe(true);
			} else {
				expect(parseAlertsKey(text).equals(key)).toBe(true);
				expect(statSync(keyFile).size).toBe(44);
			}
			if (process.platform !== 'win32') expect(statSync(keyFile).mode & 0o777).toBe(0o600);
		}
	);

	it.each(linuxBackends)(
		'linux %s: a raw key file is migrated only on a keyring (%s)',
		async (backend, wraps) => {
			const raw = seedRawKey();
			const before = fileHash(keyFile);
			const storage = fakeStorage({ getSelectedStorageBackend: () => backend });

			const key = await loadOrCreateAlertsKey(keyFile, { safeStorage: storage, platform: 'linux' });

			expect(key.equals(raw)).toBe(true);
			const text = readFileSync(keyFile, 'utf8');
			expect(text.startsWith(WRAPPED_PREFIX)).toBe(wraps);
			if (wraps) expect(unwrapped(storage, text).equals(raw)).toBe(true);
			else expect(fileHash(keyFile)).toBe(before);
			if (process.platform !== 'win32') expect(statSync(keyFile).mode & 0o777).toBe(0o600);
			expect(tempLeftovers(dir)).toEqual([]);
		}
	);

	const unavailable: [string, NodeJS.Platform, Partial<SafeStorage>][] = [
		['darwin, encryption unavailable', 'darwin', { isEncryptionAvailable: () => false }],
		['win32, encryption unavailable', 'win32', { isEncryptionAvailable: () => false }],
		['linux libsecret, encryption unavailable', 'linux', { isEncryptionAvailable: () => false }],
		[
			'darwin, isEncryptionAvailable throws',
			'darwin',
			{
				isEncryptionAvailable: () => {
					throw new Error('not ready');
				}
			}
		],
		['linux, no backend query', 'linux', { getSelectedStorageBackend: undefined }]
	];

	it.each(unavailable)('%s: new and existing key files stay raw', async (_, platform, over) => {
		const storage = fakeStorage(over);
		const fresh = await loadOrCreateAlertsKey(keyFile, { safeStorage: storage, platform });
		expect(parseAlertsKey(readFileSync(keyFile, 'utf8')).equals(fresh)).toBe(true);
		const before = fileHash(keyFile);

		const again = await loadOrCreateAlertsKey(keyFile, { safeStorage: storage, platform });

		expect(again.equals(fresh)).toBe(true);
		expect(fileHash(keyFile)).toBe(before);
		expect(storage.seen).toEqual([]);
	});

	it('migrates v0.1.5 raw key: same key, wrapped file, saved channels still open', async () => {
		const raw = seedRawKey();
		const aad = channelAad('smtp');
		const config = JSON.stringify({ host: 'smtp.example.test', port: 587, password: 'pw-123' });
		const sealed = encryptSecret(raw, config, aad);
		const storage = fakeStorage();

		const key = await loadOrCreateAlertsKey(keyFile, { safeStorage: storage, platform: 'darwin' });

		expect(key.equals(raw)).toBe(true);
		const text = readFileSync(keyFile, 'utf8');
		expect(text.startsWith(WRAPPED_PREFIX)).toBe(true);
		expect(isRawKey(text)).toBe(false);
		expect(unwrapped(storage, text).equals(raw)).toBe(true);
		expect(decryptSecret(key, sealed, aad)).toEqual({ ok: true, plaintext: config });
		expect(tempLeftovers(dir)).toEqual([]);
		if (process.platform !== 'win32') expect(statSync(keyFile).mode & 0o777).toBe(0o600);

		// The next launch reads the wrapped file as is.
		const before = fileHash(keyFile);
		const relaunched = await loadOrCreateAlertsKey(keyFile, {
			safeStorage: storage,
			platform: 'darwin'
		});
		expect(relaunched.equals(raw)).toBe(true);
		expect(decryptSecret(relaunched, sealed, aad)).toEqual({ ok: true, plaintext: config });
		expect(fileHash(keyFile)).toBe(before);
	});

	const failurePoints: [string, (raw: Buffer) => Partial<SafeStorage>][] = [
		[
			'encryptString throws',
			() => ({
				encryptString: (plain: string) => {
					throw new Error(`keychain refused ${plain}`);
				}
			})
		],
		[
			'decryptString returns other bytes',
			() => ({ decryptString: () => randomBytes(32).toString('base64') })
		],
		[
			'rename throws',
			(raw) => {
				hooks.beforeRename = () => {
					throw Object.assign(new Error(`EPERM over ${raw.toString('base64')}`), { code: 'EPERM' });
				};
				return {};
			}
		]
	];

	it.each(failurePoints)(
		'a failed migration (%s) keeps the raw file and returns its key',
		async (_, failAt) => {
			const raw = seedRawKey();
			const before = fileHash(keyFile);
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			const storage = fakeStorage(failAt(raw));

			const key = await loadOrCreateAlertsKey(keyFile, {
				safeStorage: storage,
				platform: 'darwin'
			});

			expect(key.equals(raw)).toBe(true);
			expect(fileHash(keyFile)).toBe(before);
			expect(tempLeftovers(dir)).toEqual([]);
			expect(readdirSync(dir)).toEqual(['alerts.key']);
			expect(warn).toHaveBeenCalledTimes(1);
		}
	);

	it('a temp file that cannot be removed after a failed migration is logged by path only', async () => {
		const raw = seedRawKey();
		const before = fileHash(keyFile);
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const storage = fakeStorage();
		hooks.beforeRename = () => {
			throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
		};
		hooks.beforeRm = (path) => {
			throw new Error(`rm refused ${readFileSync(path, 'utf8')} ${raw.toString('base64')}`);
		};

		const key = await loadOrCreateAlertsKey(keyFile, { safeStorage: storage, platform: 'darwin' });

		expect(key.equals(raw)).toBe(true);
		expect(fileHash(keyFile)).toBe(before);
		const [leftover] = tempLeftovers(dir);
		expect(leftover).toBeDefined();
		const logged = warn.mock.calls.map((args) => args.map(String).join(' '));
		expect(logged.some((text) => text.includes(join(dir, leftover)))).toBe(true);
		const secrets = [SENTINEL, raw.toString('base64'), ...storage.seen];
		for (const text of logged) {
			for (const secret of secrets) {
				expect(text.includes(secret), 'a secret leaked into the log').toBe(false);
			}
		}
	});

	it('safeStorage failing to report its backend leaves the key raw and is logged', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const storage = fakeStorage({
			getSelectedStorageBackend: () => {
				throw new Error(`backend down ${SENTINEL}`);
			}
		});

		const key = await loadOrCreateAlertsKey(keyFile, { safeStorage: storage, platform: 'linux' });

		expect(parseAlertsKey(readFileSync(keyFile, 'utf8')).equals(key)).toBe(true);
		expect(warn).toHaveBeenCalledTimes(1);
		const text = warn.mock.calls[0].map(String).join(' ');
		expect(text.includes(SENTINEL)).toBe(false);
		expect(text.includes(key.toString('base64'))).toBe(false);
	});

	it('a failed wrap of a new key stores it raw, and the next launch migrates it', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const failing = fakeStorage({
			encryptString: () => {
				throw new Error('keychain locked');
			}
		});

		const key = await loadOrCreateAlertsKey(keyFile, { safeStorage: failing, platform: 'darwin' });

		expect(parseAlertsKey(readFileSync(keyFile, 'utf8')).equals(key)).toBe(true);
		const storage = fakeStorage();
		const relaunched = await loadOrCreateAlertsKey(keyFile, {
			safeStorage: storage,
			platform: 'darwin'
		});
		expect(relaunched.equals(key)).toBe(true);
		expect(unwrapped(storage, readFileSync(keyFile, 'utf8')).equals(key)).toBe(true);
	});

	const unreadable: [string, SafeStorage | undefined][] = [
		[
			'decryptString throws',
			fakeStorage({
				decryptString: (encrypted: Buffer) => {
					throw new Error(`cannot decrypt ${encrypted.toString('base64')}`);
				}
			})
		],
		['no safeStorage passed', undefined]
	];

	it.each(unreadable)(
		'a wrapped file that cannot be decrypted (%s) is refused naming the path, never replaced',
		async (_, storage) => {
			await loadOrCreateAlertsKey(keyFile, { safeStorage: fakeStorage(), platform: 'darwin' });
			const before = fileHash(keyFile);

			const error = await rejection(
				loadOrCreateAlertsKey(keyFile, { safeStorage: storage, platform: 'darwin' })
			);

			expect(error).toBeInstanceOf(AlertsKeyError);
			expect(error.message.includes(keyFile)).toBe(true);
			expect(fileHash(keyFile)).toBe(before);
			expect(readdirSync(dir)).toEqual(['alerts.key']);
		}
	);

	const damagedWrapped: [string, string][] = [
		['prefix only', WRAPPED_PREFIX],
		['payload not base64', `${WRAPPED_PREFIX}not base64!!`],
		['decrypts to a non-key', `${WRAPPED_PREFIX}${Buffer.from(SENTINEL + 'zz').toString('base64')}`]
	];

	it.each(damagedWrapped)(
		'a damaged wrapped file (%s) is refused, untouched',
		async (_, contents) => {
			mkdirSync(dir, { recursive: true });
			writeFileSync(keyFile, contents);
			const before = fileHash(keyFile);

			const error = await rejection(
				loadOrCreateAlertsKey(keyFile, { safeStorage: fakeStorage(), platform: 'darwin' })
			);

			expect(error).toBeInstanceOf(AlertsKeyError);
			expect(error.message.includes(keyFile)).toBe(true);
			expect(fileHash(keyFile)).toBe(before);
		}
	);

	it('never puts the key or the ciphertext in a thrown or logged text', async () => {
		const logged: string[] = [];
		for (const level of ['log', 'warn', 'error', 'info', 'debug'] as const) {
			vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
				logged.push(
					args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : String(a))).join(' ')
				);
			});
		}
		const thrown: string[] = [];
		const secrets: string[] = [SENTINEL];
		const leaky = (label: string) => (data: string) => {
			throw new Error(`${label} ${data}`);
		};
		const run = async (storage: FakeStorage, platform: NodeJS.Platform = 'darwin') => {
			try {
				const key = await loadOrCreateAlertsKey(keyFile, { safeStorage: storage, platform });
				secrets.push(key.toString('base64'));
			} catch (error) {
				thrown.push(`${(error as Error).message} ${(error as Error).stack}`);
			}
			secrets.push(...storage.seen);
			if (existsSync(keyFile)) secrets.push(readFileSync(keyFile, 'utf8'));
		};

		// A fresh key whose wrap fails, quoting its plaintext.
		await run(fakeStorage({ encryptString: leaky('encrypt') }));
		// A raw file whose migration fails at encrypt, at the round trip, at the rename.
		removeTempDir(dir);
		secrets.push(seedRawKey().toString('base64'));
		await run(fakeStorage({ encryptString: leaky('encrypt') }));
		await run(fakeStorage({ decryptString: (b: Buffer) => `${SENTINEL} ${b.toString('base64')}` }));
		hooks.beforeRename = (dest) => {
			throw new Error(`rename ${readFileSync(dest, 'utf8')} ${secrets.join(' ')}`);
		};
		await run(fakeStorage());
		// A wrapped file whose decrypt fails, quoting the ciphertext and a key.
		await run(fakeStorage());
		await run(
			fakeStorage({
				decryptString: (b: Buffer) => {
					throw new Error(`decrypt ${b.toString('base64')} ${secrets.join(' ')}`);
				}
			})
		);

		expect(thrown.length).toBe(1);
		expect(logged.length).toBeGreaterThan(0);
		for (const text of [...thrown, ...logged]) {
			for (const secret of secrets) {
				expect(text.includes(secret.trim()), 'a secret leaked into a message').toBe(false);
			}
		}
	});

	it('concurrent loads over one raw file agree on its key and leave one wrapped file', async () => {
		const raw = seedRawKey();
		const storage = fakeStorage();

		const keys = await Promise.all(
			Array.from({ length: 8 }, () =>
				loadOrCreateAlertsKey(keyFile, { safeStorage: storage, platform: 'darwin' })
			)
		);

		expect(keys.every((k) => k.equals(raw))).toBe(true);
		expect(readdirSync(dir)).toEqual(['alerts.key']);
		expect(unwrapped(storage, readFileSync(keyFile, 'utf8')).equals(raw)).toBe(true);
	});

	it('concurrent first launches with a keyring agree on one wrapped key', async () => {
		const storage = fakeStorage();

		const keys = await Promise.all(
			Array.from({ length: 8 }, () =>
				loadOrCreateAlertsKey(keyFile, { safeStorage: storage, platform: 'darwin' })
			)
		);

		expect(new Set(keys.map((k) => sha256(k))).size).toBe(1);
		expect(readdirSync(dir)).toEqual(['alerts.key']);
		expect(unwrapped(storage, readFileSync(keyFile, 'utf8')).equals(keys[0])).toBe(true);
	});

	posixOnly('a raw file is left raw when no safeStorage is passed', async () => {
		const raw = seedRawKey();
		const before = fileHash(keyFile);

		const key = await loadOrCreateAlertsKey(keyFile);

		expect(key.equals(raw)).toBe(true);
		expect(fileHash(keyFile)).toBe(before);
		expect(statSync(keyFile).mode & 0o777).toBe(0o600);
	});
});
