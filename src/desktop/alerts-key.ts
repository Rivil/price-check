// The desktop's alerts encryption key (spec c-2, decision alerts_key_storage): 32
// random bytes in a userData file (0600 on POSIX). Created once on first launch and
// never regenerated: every saved channel credential is sealed under it, so a new key
// would make them all undecryptable. A damaged key file is refused, never replaced —
// the user decides whether to restore or discard it.
//
// At rest (06-remediate-security c-24, c-25; SEC-15): where Electron's safeStorage
// has a real OS backend (macOS Keychain, Windows DPAPI, Linux libsecret or kwallet),
// the file holds the key wrapped by it: 'pcw1:' (never valid base64, so it cannot be
// mistaken for a raw key) plus the base64 safeStorage ciphertext of the key's base64.
// Without one (Linux basic_text, encryption unavailable, or no safeStorage passed)
// it holds the key's base64 as before. A raw v0.1.5 file is migrated in place: the
// wrapped form is written and fsynced to a private temp file, read back and
// decrypted to the same key, then renamed over the raw file. Any failure on the way
// keeps the raw file as it was and returns its key; the next launch tries again. A
// wrapped file that does not decrypt is refused like a damaged one and never
// replaced: the keychain may come back, a new key would not.
//
// Creation is atomic and exclusive: the key is written and fsynced to a private
// temp file, then hard-linked to the final name. link() fails if the name exists,
// so two launches racing on an empty dir agree on one key, and a reader never sees
// a half-written file. A temp file left by an interrupted write is never read.
//
// Nothing here ever puts the key, the file's contents or a safeStorage error (which
// may quote either) into an error message or the log.
// Runs in the Electron main bundle: no $app/* imports, no electron import —
// safeStorage arrives as the structural SafeStorage type below.
import { randomBytes } from 'node:crypto';
import { link, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { AlertsKeyError, parseAlertsKey } from '#lib/server/alerts/crypto.ts';

const KEY_BYTES = 32;
const KEY_MODE = 0o600;
/** Marks a safeStorage-wrapped key file; ':' keeps it from parsing as base64. */
export const WRAPPED_PREFIX = 'pcw1:';
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
/** Linux backends that keep the secret in an OS keyring rather than a fixed password. */
const LINUX_KEYRING_BACKEND = /^(gnome_libsecret|kwallet\d*)$/;

/** The slice of Electron's safeStorage used here (type-only: no electron import). */
export type SafeStorage = {
	isEncryptionAvailable(): boolean;
	encryptString(plainText: string): Buffer;
	decryptString(encrypted: Buffer): string;
	/** Linux only in Electron: 'basic_text', 'gnome_libsecret', 'kwallet5', ... */
	getSelectedStorageBackend?(): string;
};

export type AlertsKeyOptions = {
	/** Electron's safeStorage; without it the key file stays raw, as before 06. */
	safeStorage?: SafeStorage;
	platform?: NodeJS.Platform;
};

function errorCode(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException | undefined)?.code;
}

/** An fs error code like EACCES for the log, or '' for anything else (never a message). */
function safeCode(error: unknown): string {
	const code = errorCode(error);
	return typeof code === 'string' && /^E[A-Z]+$/.test(code) ? `, ${code}` : '';
}

/**
 * The safeStorage to wrap keys with, or null where it has no real OS backend: on
 * Linux, basic_text (a fixed password in Chromium's source) protects nothing a 0600
 * file does not, so the file stays raw there.
 */
export function wrappingStorage(
	safeStorage: SafeStorage | undefined,
	platform: NodeJS.Platform
): SafeStorage | null {
	if (safeStorage === undefined) return null;
	try {
		if (!safeStorage.isEncryptionAvailable()) return null;
		if (platform !== 'linux') return safeStorage;
		const backend = safeStorage.getSelectedStorageBackend?.() ?? '';
		return LINUX_KEYRING_BACKEND.test(backend) ? safeStorage : null;
	} catch {
		// Raw is the pre-06 form, still 0600 and still readable next launch, which
		// tries the backend again; refusing to start would lock the user out instead.
		// The error is not logged: it may come from a keychain that quotes secrets.
		console.warn(
			'[desktop] safeStorage could not report its backend; the alerts key stays unwrapped'
		);
		return null;
	}
}

function damaged(keyFile: string): AlertsKeyError {
	return new AlertsKeyError(
		`The alerts key file ${keyFile} is damaged: it must hold base64 of 32 bytes. ` +
			'It was left untouched, because saved alert channel credentials can only be ' +
			'decrypted with the original key. Restore it from a backup, or delete it to ' +
			'start with a new key (alert channels then need their credentials entered again).'
	);
}

function undecryptable(keyFile: string): AlertsKeyError {
	return new AlertsKeyError(
		`The alerts key file ${keyFile} is encrypted with this computer's keychain, and ` +
			'it could not be decrypted. It was left untouched, because saved alert channel ' +
			'credentials can only be decrypted with the original key. Unlock or restore the ' +
			'keychain, or delete the file to start with a new key (alert channels then need ' +
			'their credentials entered again).'
	);
}

/** The key's file form wrapped by `storage`. Throws whatever safeStorage throws. */
function wrapKey(storage: SafeStorage, key: Buffer): string {
	return WRAPPED_PREFIX + storage.encryptString(key.toString('base64')).toString('base64');
}

/**
 * The key in a wrapped file's contents; AlertsKeyError naming the path if it is not
 * one, or safeStorage cannot decrypt it. safeStorage's own error is dropped.
 */
function unwrapKey(keyFile: string, storage: SafeStorage | undefined, contents: string): Buffer {
	const payload = contents.trim().slice(WRAPPED_PREFIX.length);
	if (payload.length % 4 !== 0 || !BASE64.test(payload)) throw damaged(keyFile);
	if (storage === undefined) throw undecryptable(keyFile);
	let decrypted: string;
	try {
		decrypted = storage.decryptString(Buffer.from(payload, 'base64'));
	} catch {
		throw undecryptable(keyFile);
	}
	try {
		return parseAlertsKey(decrypted);
	} catch {
		throw damaged(keyFile);
	}
}

/** The key in an existing file, raw or wrapped; AlertsKeyError naming the path if invalid. */
function decodeKeyFile(keyFile: string, contents: string, storage?: SafeStorage): Buffer {
	if (contents.trim().startsWith(WRAPPED_PREFIX)) return unwrapKey(keyFile, storage, contents);
	try {
		return parseAlertsKey(contents);
	} catch (error) {
		if (!(error instanceof AlertsKeyError)) throw error;
		throw damaged(keyFile);
	}
}

/** The key file's contents, or null when it does not exist. */
async function readIfPresent(keyFile: string): Promise<string | null> {
	try {
		return await readFile(keyFile, 'utf8');
	} catch (error) {
		if (errorCode(error) === 'ENOENT') return null;
		throw error;
	}
}

/** Makes the new link durable on POSIX; Windows cannot open a directory for fsync. */
async function syncDir(dir: string): Promise<void> {
	if (process.platform === 'win32') return;
	const handle = await open(dir, 'r');
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

/** A private temp file name beside keyFile; '.tmp-' marks it as never read. */
function tempPathFor(keyFile: string): string {
	return `${keyFile}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
}

/** Creates `file` (which must not exist) at mode 0600 holding `contents`, fsynced. */
async function writePrivate(file: string, contents: string): Promise<void> {
	const handle = await open(file, 'wx', KEY_MODE);
	try {
		await handle.writeFile(contents, 'utf8');
		await handle.sync();
	} finally {
		await handle.close();
	}
}

/**
 * The file form for a fresh key: wrapped when `storage` is set and a decrypt round
 * trip gives the key back, else raw (logged), so a failing keychain never blocks a
 * first launch; the next launch migrates the raw file.
 */
function freshKeyContents(key: Buffer, storage: SafeStorage | null): string {
	if (storage === null) return key.toString('base64');
	try {
		const wrapped = wrapKey(storage, key);
		const payload = Buffer.from(wrapped.slice(WRAPPED_PREFIX.length), 'base64');
		if (parseAlertsKey(storage.decryptString(payload)).equals(key)) return wrapped;
	} catch {
		// Fall through: the reason may quote the key, so it is not logged.
	}
	console.warn('[desktop] the new alerts key could not be wrapped; it was stored unwrapped');
	return key.toString('base64');
}

/**
 * Writes a fresh key to keyFile unless one already exists. Returns the key that is
 * on disk afterwards: the new one, or a competitor's that got there first.
 */
async function createKeyFile(keyFile: string, options: AlertsKeyOptions): Promise<Buffer> {
	const dir = dirname(keyFile);
	const temp = tempPathFor(keyFile);
	const key = randomBytes(KEY_BYTES);
	const storage = wrappingStorage(options.safeStorage, options.platform ?? process.platform);
	try {
		await writePrivate(temp, freshKeyContents(key, storage));
		try {
			await link(temp, keyFile);
		} catch (error) {
			if (errorCode(error) !== 'EEXIST') throw error;
			// Another launch created it first: its key is the one, ours is discarded.
			return decodeKeyFile(keyFile, await readFile(keyFile, 'utf8'), options.safeStorage);
		}
		await syncDir(dir);
		return key;
	} finally {
		await rm(temp, { force: true });
	}
}

/**
 * Removes a migration's temp file. A failure is logged with the path only (never
 * the error, which may quote the file) and does not change the migration's
 * outcome: the key file is the raw one, untouched, and the leftover '.tmp-' file
 * is never read as a key, so it is only clutter for the user to delete.
 */
async function removeTemp(temp: string): Promise<void> {
	try {
		await rm(temp, { force: true });
	} catch {
		console.warn(`[desktop] a temporary alerts key file could not be removed: ${temp}`);
	}
}

/**
 * Replaces the raw key file holding `key` with its wrapped form. Never throws: on
 * any failure the raw file is left as it was and the reason (stage and fs code
 * only) is logged. Racing launches each rename their own wrapped copy of the same
 * key, so whichever lands last, the file holds that key.
 */
async function migrateToWrapped(keyFile: string, key: Buffer, storage: SafeStorage): Promise<void> {
	const temp = tempPathFor(keyFile);
	let stage = 'encrypt';
	try {
		const wrapped = wrapKey(storage, key);
		stage = 'write';
		await writePrivate(temp, wrapped);
		stage = 'verify';
		const back = unwrapKey(keyFile, storage, await readFile(temp, 'utf8'));
		if (!back.equals(key)) throw new Error('round trip gave another key');
		stage = 'replace';
		await rename(temp, keyFile);
	} catch (error) {
		console.warn(
			`[desktop] the alerts key file was not wrapped (${stage}${safeCode(error)}); ` +
				'it was kept unwrapped'
		);
		await removeTemp(temp);
		return;
	}
	// The rename has happened; a lost dir sync only risks the raw file coming back
	// after a crash, which still holds the same key.
	await syncDir(dirname(keyFile)).catch(() => undefined);
}

/**
 * The alerts key in keyFile, created (with any missing parent dirs) on first launch.
 * With a real safeStorage backend (see wrappingStorage) a new key is written
 * wrapped and a raw one is migrated to wrapped. An invalid file, or a wrapped one
 * that does not decrypt, throws AlertsKeyError naming the file path and is left as
 * it is.
 */
export async function loadOrCreateAlertsKey(
	keyFile: string,
	options: AlertsKeyOptions = {}
): Promise<Buffer> {
	await mkdir(dirname(keyFile), { recursive: true });
	const existing = await readIfPresent(keyFile);
	if (existing === null) return createKeyFile(keyFile, options);
	const key = decodeKeyFile(keyFile, existing, options.safeStorage);
	if (existing.trim().startsWith(WRAPPED_PREFIX)) return key;
	const storage = wrappingStorage(options.safeStorage, options.platform ?? process.platform);
	if (storage !== null) await migrateToWrapped(keyFile, key, storage);
	return key;
}
