// The desktop's alerts encryption key (spec c-2, decision alerts_key_storage): 32
// random bytes, base64, in a userData file (0600 on POSIX). Created once on first
// launch and never rewritten: every saved channel credential is sealed under it, so
// a regenerated key would make them all undecryptable. A damaged key file is
// refused, never replaced — the user decides whether to restore or discard it.
//
// Creation is atomic and exclusive: the key is written and fsynced to a private
// temp file, then hard-linked to the final name. link() fails if the name exists,
// so two launches racing on an empty dir agree on one key, and a reader never sees
// a half-written file. A temp file left by an interrupted write is never read.
//
// Nothing here ever puts the key or the file's contents into an error message.
// Runs in the Electron main bundle: no $app/* imports, no electron import.
import { randomBytes } from 'node:crypto';
import { link, mkdir, open, readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { AlertsKeyError, parseAlertsKey } from '#lib/server/alerts/crypto.ts';

const KEY_BYTES = 32;
const KEY_MODE = 0o600;

function errorCode(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException | undefined)?.code;
}

/** The key in an existing file; AlertsKeyError naming the path if it is not a valid key. */
function decodeKeyFile(keyFile: string, contents: string): Buffer {
	try {
		return parseAlertsKey(contents);
	} catch (error) {
		if (!(error instanceof AlertsKeyError)) throw error;
		throw new AlertsKeyError(
			`The alerts key file ${keyFile} is damaged: it must hold base64 of 32 bytes. ` +
				'It was left untouched, because saved alert channel credentials can only be ' +
				'decrypted with the original key. Restore it from a backup, or delete it to ' +
				'start with a new key (alert channels then need their credentials entered again).'
		);
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

/**
 * Writes a fresh key to keyFile unless one already exists. Returns the key that is
 * on disk afterwards: the new one, or a competitor's that got there first.
 */
async function createKeyFile(keyFile: string): Promise<Buffer> {
	const dir = dirname(keyFile);
	const temp = `${keyFile}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
	const key = randomBytes(KEY_BYTES);
	try {
		const handle = await open(temp, 'wx', KEY_MODE);
		try {
			await handle.writeFile(key.toString('base64'), 'utf8');
			await handle.sync();
		} finally {
			await handle.close();
		}
		try {
			await link(temp, keyFile);
		} catch (error) {
			if (errorCode(error) !== 'EEXIST') throw error;
			// Another launch created it first: its key is the one, ours is discarded.
			return decodeKeyFile(keyFile, await readFile(keyFile, 'utf8'));
		}
		await syncDir(dir);
		return key;
	} finally {
		await rm(temp, { force: true });
	}
}

/**
 * The alerts key in keyFile, created (with any missing parent dirs) on first launch.
 * An existing file is never rewritten; an invalid one throws AlertsKeyError naming
 * the file path.
 */
export async function loadOrCreateAlertsKey(keyFile: string): Promise<Buffer> {
	await mkdir(dirname(keyFile), { recursive: true });
	const existing = await readIfPresent(keyFile);
	if (existing !== null) return decodeKeyFile(keyFile, existing);
	return createKeyFile(keyFile);
}
