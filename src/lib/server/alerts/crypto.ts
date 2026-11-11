// Alert channel credentials at rest (decision encryption_key): AES-256-GCM under a
// dedicated ALERTS_ENCRYPTION_KEY, bound to the owning user and channel kind by the
// AAD, so a ciphertext copied into another user's row does not decrypt.
//
// Kept free of $app/$env imports: the e2e seed and the legacy backfill load it too.
// Nothing here ever puts a key, a plaintext or a ciphertext into an error message.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const PREFIX = 'v1:';
const GENERATE = 'generate one with `openssl rand -base64 32`';

/** Every refusal about the key; its message names the variable, never its value. */
export class AlertsKeyError extends Error {
	override name = 'AlertsKeyError';
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** ALERTS_ENCRYPTION_KEY (base64 of exactly 32 bytes) -> the key; throws AlertsKeyError otherwise. */
export function parseAlertsKey(raw: string | undefined): Buffer {
	const value = raw?.trim() ?? '';
	if (value === '') {
		throw new AlertsKeyError(
			`ALERTS_ENCRYPTION_KEY is not set; it encrypts alert channel credentials — ${GENERATE}`
		);
	}
	if (value.length % 4 !== 0 || !BASE64.test(value)) {
		throw new AlertsKeyError(`ALERTS_ENCRYPTION_KEY is not valid base64 — ${GENERATE}`);
	}
	const key = Buffer.from(value, 'base64');
	if (key.toString('base64') !== value) {
		throw new AlertsKeyError(`ALERTS_ENCRYPTION_KEY is not valid base64 — ${GENERATE}`);
	}
	if (key.length !== KEY_BYTES) {
		throw new AlertsKeyError(
			`ALERTS_ENCRYPTION_KEY must be 32 bytes once base64-decoded (it is ${key.length}) — ${GENERATE}`
		);
	}
	return key;
}

let current: Buffer | undefined;

/** Install the process's key; the server does this once at startup. */
export function setAlertsKey(key: Buffer): void {
	if (key.length !== KEY_BYTES) {
		throw new AlertsKeyError('ALERTS_ENCRYPTION_KEY must be 32 bytes once base64-decoded');
	}
	current = key;
}

/** The process's key; throws AlertsKeyError if startup has not installed one. */
export function alertsKey(): Buffer {
	if (current === undefined) {
		throw new AlertsKeyError('ALERTS_ENCRYPTION_KEY has not been loaded (setAlertsKey not called)');
	}
	return current;
}

/** Additional authenticated data binding a ciphertext to one user's channel of one kind. */
export function channelAad(userId: string, kind: string): string {
	return JSON.stringify(['alert-channel', userId, kind]);
}

/** 'v1:' + base64(iv | tag | ciphertext); a fresh random IV every call. */
export function encryptSecret(key: Buffer, plaintext: string, aad: string): string {
	const iv = randomBytes(IV_BYTES);
	const cipher = createCipheriv('aes-256-gcm', key, iv);
	cipher.setAAD(Buffer.from(aad, 'utf8'));
	const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
	return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

export type Decrypted = { ok: true; plaintext: string } | { ok: false };

/** Never throws: a wrong key, AAD, version or any tampering is {ok: false}. */
export function decryptSecret(key: Buffer, payload: string, aad: string): Decrypted {
	try {
		if (!payload.startsWith(PREFIX)) return { ok: false };
		const blob = Buffer.from(payload.slice(PREFIX.length), 'base64');
		if (blob.length < IV_BYTES + TAG_BYTES) return { ok: false };
		const decipher = createDecipheriv('aes-256-gcm', key, blob.subarray(0, IV_BYTES));
		decipher.setAAD(Buffer.from(aad, 'utf8'));
		decipher.setAuthTag(blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
		const plain = Buffer.concat([
			decipher.update(blob.subarray(IV_BYTES + TAG_BYTES)),
			decipher.final()
		]);
		return { ok: true, plaintext: plain.toString('utf8') };
	} catch {
		return { ok: false };
	}
}
