import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
	AlertsKeyError,
	channelAad,
	decryptSecret,
	encryptSecret,
	parseAlertsKey
} from './crypto.ts';

const KEY = randomBytes(32);
const AAD = channelAad('ntfy');
/** The AAD a channel was sealed under before 02-single-user: per user as well as kind. */
const LEGACY_AAD = JSON.stringify(['alert-channel', 'alice', 'ntfy']);
const URL = 'https://ntfy.sh/t';

function refusal(raw: string | undefined): Error {
	try {
		parseAlertsKey(raw);
	} catch (error) {
		return error as Error;
	}
	throw new Error('parseAlertsKey accepted the key');
}

describe('parseAlertsKey', () => {
	it('key', () => {
		const short = randomBytes(31).toString('base64');
		const long = randomBytes(33).toString('base64');
		for (const raw of [undefined, '', '   ', 'not-base64!!', 'abc', 'Zm9v=YmFy', short, long]) {
			const error = refusal(raw);
			expect(error, String(raw)).toBeInstanceOf(AlertsKeyError);
			expect(error.name).toBe('AlertsKeyError');
			expect(error.message, String(raw)).toContain('ALERTS_ENCRYPTION_KEY');
			expect(error.message, String(raw)).toContain('openssl rand -base64 32');
			if (raw !== undefined && raw.trim() !== '') {
				expect(error.message, raw).not.toContain(raw);
			}
		}
		for (const raw of [short, long]) {
			expect(refusal(raw).message).toMatch(/must be 32 bytes/);
		}
		// The refusal says why: missing is not the same as malformed.
		for (const raw of [undefined, '', '   ']) {
			expect(refusal(raw).message, String(raw)).toMatch(/^ALERTS_ENCRYPTION_KEY is not set;/);
		}
		for (const raw of ['not-base64!!', 'abc', 'Zm9v=YmFy']) {
			expect(refusal(raw).message, raw).toMatch(/^ALERTS_ENCRYPTION_KEY is not valid base64 — /);
		}

		const valid = randomBytes(32);
		for (const raw of [valid.toString('base64'), `${valid.toString('base64')}\n`]) {
			const key = parseAlertsKey(raw);
			expect(Buffer.isBuffer(key)).toBe(true);
			expect(key.length).toBe(32);
			expect(key.equals(valid)).toBe(true);
		}
	});

	it('non-canonical', () => {
		// 32 bytes leave 2 spare bits in the last character before '='; setting one
		// still decodes to the same 32 bytes, so only the round-trip check refuses it.
		const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
		const canonical = randomBytes(32).toString('base64');
		const last = ALPHABET.indexOf(canonical[42]);
		expect(last % 4).toBe(0);
		const raw = `${canonical.slice(0, 42)}${ALPHABET[last + 1]}=`;
		expect(Buffer.from(raw, 'base64').equals(Buffer.from(canonical, 'base64'))).toBe(true);

		const error = refusal(raw);
		expect(error).toBeInstanceOf(AlertsKeyError);
		expect(error.message).toBe(
			'ALERTS_ENCRYPTION_KEY is not valid base64 — generate one with `openssl rand -base64 32`'
		);
	});
});

describe('encryptSecret', () => {
	it('iv', () => {
		const a = encryptSecret(KEY, URL, AAD);
		const b = encryptSecret(KEY, URL, AAD);
		expect(a).not.toBe(b);
		for (const sealed of [a, b]) {
			expect(sealed.startsWith('v1:')).toBe(true);
			expect(sealed).not.toContain(URL);
			expect(sealed).not.toContain('ntfy.sh');
			expect(Buffer.from(sealed.slice(3), 'base64').toString('latin1')).not.toContain('ntfy');
		}
		expect(decryptSecret(KEY, a, AAD)).toEqual({ ok: true, plaintext: URL });
		expect(decryptSecret(KEY, b, AAD)).toEqual({ ok: true, plaintext: URL });
	});
});

describe('decryptSecret', () => {
	it('tamper', () => {
		const sealed = encryptSecret(KEY, URL, AAD);
		const blob = Buffer.from(sealed.slice(3), 'base64');

		const flipped = (index: number) => {
			const copy = Buffer.from(blob);
			copy[index] = copy[index]! ^ 0x01;
			return `v1:${copy.toString('base64')}`;
		};

		const cases: [string, Buffer, string, string][] = [
			['last ciphertext byte', KEY, flipped(blob.length - 1), AAD],
			['first ciphertext byte', KEY, flipped(28), AAD],
			['iv byte', KEY, flipped(0), AAD],
			['tag byte', KEY, flipped(12), AAD],
			['other key', randomBytes(32), sealed, AAD],
			['legacy per-user AAD', KEY, sealed, LEGACY_AAD],
			['other kind', KEY, sealed, channelAad('smtp')],
			['another kind', KEY, sealed, channelAad('resend')],
			['v2 prefix', KEY, `v2:${sealed.slice(3)}`, AAD],
			['no prefix', KEY, sealed.slice(3), AAD],
			['truncated', KEY, sealed.slice(0, 20), AAD],
			['empty', KEY, '', AAD],
			['garbage', KEY, 'v1:!!!', AAD],
			['short key', randomBytes(31), sealed, AAD]
		];
		for (const [label, key, payload, aad] of cases) {
			let result: unknown;
			expect(() => (result = decryptSecret(key, payload, aad)), label).not.toThrow();
			expect(result, label).toEqual({ ok: false });
		}
		expect(decryptSecret(KEY, sealed, AAD)).toEqual({ ok: true, plaintext: URL });
	});
});

describe('channelAad', () => {
	it('names the kind only', () => {
		expect(channelAad('ntfy')).toBe('["alert-channel","ntfy"]');
		expect(channelAad('ntfy')).not.toBe(channelAad('smtp'));
		expect(channelAad('ntfy')).not.toBe(LEGACY_AAD);
	});

	it('a blob sealed for one kind opens only as that kind', () => {
		const sealed = encryptSecret(KEY, URL, channelAad('ntfy'));
		expect(decryptSecret(KEY, sealed, channelAad('smtp'))).toEqual({ ok: false });
		expect(decryptSecret(KEY, sealed, channelAad('ntfy'))).toEqual({ ok: true, plaintext: URL });

		// Sealed under the old per-user AAD: no longer opens as the kind's channel.
		const legacy = encryptSecret(KEY, URL, LEGACY_AAD);
		expect(decryptSecret(KEY, legacy, channelAad('ntfy'))).toEqual({ ok: false });
	});
});

describe('alertsKey', () => {
	it('unset', async () => {
		vi.resetModules();
		const fresh = await import('./crypto.ts');
		let thrown: unknown;
		try {
			fresh.alertsKey();
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(fresh.AlertsKeyError);
		expect((thrown as Error).name).toBe('AlertsKeyError');
		expect((thrown as Error).message).toContain('ALERTS_ENCRYPTION_KEY');

		expect(() => fresh.setAlertsKey(randomBytes(31))).toThrow(fresh.AlertsKeyError);
		expect(() => fresh.setAlertsKey(randomBytes(31))).toThrow(
			'ALERTS_ENCRYPTION_KEY must be 32 bytes once base64-decoded'
		);
		const key = randomBytes(32);
		fresh.setAlertsKey(key);
		expect(fresh.alertsKey()).toBe(key);
	});
});
