import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb } from '../db/client.ts';
import { notifyChannel, priceDropDelivery, watch } from '../db/schema.ts';
import { createTestDb, type TestDb } from '../testing/test-db.ts';
import type { ChannelDriver, ChannelKind } from './channel.ts';
import {
	NO_KINDS_MESSAGE,
	UNKNOWN_KIND_MESSAGE,
	channelKinds,
	channelsFor,
	driverFor,
	listChannels,
	loadChannelConfig,
	registerDriver,
	removeChannel,
	saveChannel,
	setEnabled,
	type AnyDriver
} from './channels.ts';
import { channelAad, encryptSecret } from './crypto.ts';
import { ntfyDriver, parseToken, parseTopicUrl } from './ntfy.ts';

const KEY = randomBytes(32);
const TOPIC = 'https://ntfy.sh/alice-own-secret-topic';
const TOKEN = 'tk_aliceSecretToken0123456789abcd'; // token-shaped, not a real one
const TOKEN_2 = 'tk_aliceSecondToken0123456789abcd';
const RESEND_KEY = 're_AliceResend_9fQ2xLm7Tz0kWv3'; // key-shaped, not a real one
const RESEND_FORM = {
	api_key: RESEND_KEY,
	from: 'alerts@alice-shop.test',
	to: 'alice@example.test'
};
const SMTP_PASSWORD = 'qzpx vtrw mkdl hsye'; // app-password-shaped, not a real one
const SMTP_FORM = {
	host: 'smtp.alice-mail.test',
	port: '587',
	username: 'alice@alice-mail.test',
	password: SMTP_PASSWORD,
	from: 'alerts@alice-shop.test',
	to: 'alice@example.test'
};
/** The AAD a channel was sealed under before 02-single-user: per user as well as kind. */
const LEGACY_AAD = JSON.stringify(['alert-channel', 'alice', 'ntfy']);

let h: TestDb;
let logs: string[];
const log = (message: string) => logs.push(message);
let unregister: (() => void)[] = [];

/** A second channel type for routing tests: one plain field, no secrets. */
function fakeDriver(kind: string): AnyDriver {
	const driver: ChannelDriver<{ value: string }> = {
		kind: kind as ChannelKind,
		defaultKinds: ['price_drop', 'check_failed'],
		parseConfig: (form) =>
			form.value ? { ok: true, config: { value: form.value } } : { ok: false, message: 'value' },
		view: (config) => ({ value: config.value }),
		send: async () => ({ ok: true })
	};
	return driver as AnyDriver;
}

beforeEach(async () => {
	h = await createTestDb();
	logs = [];
});
afterEach(() => {
	for (const undo of unregister.reverse()) undo();
	unregister = [];
	h.dispose();
});

const saveNtfy = (topic = TOPIC, token = TOKEN, routing?: Parameters<typeof saveChannel>[4]) =>
	saveChannel(h.db, KEY, 'ntfy', { topic, token }, routing);

const rows = () => h.db.select().from(notifyChannel).orderBy(asc(notifyChannel.kind));

/** Every byte of the database file and its side files, once the client is closed. */
function fileBytes() {
	h.db.$client.close();
	return [h.file, `${h.file}-wal`, `${h.file}-journal`]
		.filter((path) => existsSync(path))
		.map((path) => readFileSync(path).toString('latin1'))
		.join('');
}

describe('saveChannel', () => {
	it('at rest', async () => {
		expect(await saveNtfy()).toEqual({ ok: true });
		const [row] = await rows();
		expect(row.configEnc).toMatch(/^v1:/);
		for (const secret of [TOPIC, 'alice-own-secret-topic', TOKEN]) {
			expect(row.configEnc).not.toContain(secret);
		}

		const bytes = fileBytes();
		expect(bytes.length).toBeGreaterThan(0);
		for (const secret of ['alice-own-secret-topic', 'ntfy.sh', TOKEN, 'aliceSecretToken']) {
			expect(bytes.includes(secret), secret).toBe(false);
		}
	});

	it('survives reopen', async () => {
		// Saved on client A; read back on client B over the same file with the same key.
		await saveNtfy();
		await saveChannel(h.db, KEY, 'resend', RESEND_FORM);
		h.db.$client.close();

		const reopened = createDb(h.url);
		try {
			expect(await loadChannelConfig(reopened, KEY, 'ntfy')).toEqual({ url: TOPIC, token: TOKEN });
			expect(await listChannels(reopened, KEY, { log })).toEqual({
				ntfy: {
					enabled: true,
					priceDrops: true,
					checkFailures: true,
					unreadable: false,
					view: { topic: TOPIC, tokenSet: true }
				},
				resend: {
					enabled: true,
					priceDrops: true,
					checkFailures: false,
					unreadable: false,
					view: { from: 'alerts@alice-shop.test', to: 'alice@example.test', keySet: true }
				}
			});
			const routed = await channelsFor(reopened, KEY, 'price_drop', { log });
			expect(routed.map((c) => c.kind)).toEqual(['ntfy', 'resend']);
			expect(logs).toEqual([]);
		} finally {
			reopened.$client.close();
		}
	});

	it('resend at rest', async () => {
		expect(await saveChannel(h.db, KEY, 'resend', RESEND_FORM)).toEqual({ ok: true });
		const [row] = await rows();
		expect(row.configEnc).toMatch(/^v1:/);
		expect(row.configEnc).not.toContain(RESEND_KEY);
		expect(await loadChannelConfig(h.db, KEY, 'resend')).toEqual({
			apiKey: RESEND_KEY,
			from: 'alerts@alice-shop.test',
			to: 'alice@example.test'
		});

		const bytes = fileBytes();
		expect(bytes.length).toBeGreaterThan(0);
		for (const secret of [RESEND_KEY, 'AliceResend_9fQ2xLm7Tz0kWv3']) {
			expect(bytes.includes(secret), secret).toBe(false);
		}
	});

	it('resend defaults', async () => {
		await saveChannel(h.db, KEY, 'resend', RESEND_FORM);
		expect(await rows()).toMatchObject([
			{ kind: 'resend', enabled: true, priceDrops: true, checkFailures: false }
		]);
		const views = await listChannels(h.db, KEY);
		expect(views.resend?.view).toEqual({
			from: 'alerts@alice-shop.test',
			to: 'alice@example.test',
			keySet: true
		});
		expect(JSON.stringify(views)).not.toContain(RESEND_KEY);
	});

	it('smtp at rest', async () => {
		expect(await saveChannel(h.db, KEY, 'smtp', SMTP_FORM)).toEqual({ ok: true });
		const [row] = await rows();
		expect(row.configEnc).toMatch(/^v1:/);
		expect(row.configEnc).not.toContain(SMTP_PASSWORD);
		expect(await loadChannelConfig(h.db, KEY, 'smtp')).toEqual({
			host: 'smtp.alice-mail.test',
			port: 587,
			username: 'alice@alice-mail.test',
			password: SMTP_PASSWORD,
			from: 'alerts@alice-shop.test',
			to: 'alice@example.test'
		});

		const bytes = fileBytes();
		expect(bytes.length).toBeGreaterThan(0);
		for (const secret of [SMTP_PASSWORD, 'qzpx', 'vtrw mkdl', 'hsye']) {
			expect(bytes.includes(secret), secret).toBe(false);
		}
	});

	it('smtp defaults', async () => {
		await saveChannel(h.db, KEY, 'smtp', SMTP_FORM);
		expect(await rows()).toMatchObject([
			{ kind: 'smtp', enabled: true, priceDrops: true, checkFailures: false }
		]);
		const views = await listChannels(h.db, KEY);
		expect(views.smtp).toEqual({
			enabled: true,
			priceDrops: true,
			checkFailures: false,
			unreadable: false,
			view: {
				host: 'smtp.alice-mail.test',
				port: '587',
				username: 'alice@alice-mail.test',
				from: 'alerts@alice-shop.test',
				to: 'alice@example.test',
				passwordSet: true
			}
		});
		expect(JSON.stringify(views)).not.toContain(SMTP_PASSWORD);

		// So it is routed price drops and not failed checks, until they are ticked.
		expect(await channelsFor(h.db, KEY, 'check_failed')).toEqual([]);
		expect((await channelsFor(h.db, KEY, 'price_drop')).map((c) => c.kind)).toEqual(['smtp']);
	});

	it('write-only', async () => {
		await saveNtfy();
		expect(await loadChannelConfig(h.db, KEY, 'ntfy')).toEqual({ url: TOPIC, token: TOKEN });

		// Blank (or whitespace) keeps the saved token, even while the topic changes.
		for (const blank of ['', '   ']) {
			await saveNtfy('https://ntfy.sh/alice-moved', blank);
			expect(await loadChannelConfig(h.db, KEY, 'ntfy')).toEqual({
				url: 'https://ntfy.sh/alice-moved',
				token: TOKEN
			});
		}

		await saveNtfy(TOPIC, TOKEN_2);
		expect(await loadChannelConfig(h.db, KEY, 'ntfy')).toEqual({ url: TOPIC, token: TOKEN_2 });
		expect(await rows()).toHaveLength(1);
	});

	it('defaults', async () => {
		await saveNtfy();
		expect(await rows()).toMatchObject([
			{ kind: 'ntfy', enabled: true, priceDrops: true, checkFailures: true }
		]);

		// A re-save without routing keeps the saved kinds and the enabled state.
		await saveNtfy(TOPIC, '', { priceDrops: false, checkFailures: true });
		await setEnabled(h.db, 'ntfy', false);
		await saveNtfy(TOPIC, '');
		expect(await rows()).toMatchObject([
			{ enabled: false, priceDrops: false, checkFailures: true }
		]);
	});

	it('kinds', async () => {
		const none = { priceDrops: false, checkFailures: false };
		expect(await saveNtfy(TOPIC, TOKEN, none)).toEqual({ ok: false, message: NO_KINDS_MESSAGE });
		expect(await rows()).toEqual([]);

		await saveNtfy(TOPIC, TOKEN, { priceDrops: true, checkFailures: false });
		const [before] = await rows();
		expect(await saveNtfy('https://ntfy.sh/other', TOKEN_2, none)).toEqual({
			ok: false,
			message: NO_KINDS_MESSAGE
		});
		expect(await rows()).toEqual([before]);
	});

	it('invalid', async () => {
		const badTopic = parseTopicUrl('http://ntfy.sh/plain-http');
		const badToken = parseToken('not-a-token-typed-secret');
		if (badTopic.ok || badToken.ok) throw new Error('fixtures should be invalid');

		expect(await saveNtfy('http://ntfy.sh/plain-http')).toEqual({
			ok: false,
			message: badTopic.message
		});
		const tokenResult = await saveNtfy(TOPIC, 'not-a-token-typed-secret');
		expect(tokenResult).toEqual({ ok: false, message: badToken.message });
		expect(JSON.stringify(tokenResult)).not.toContain('not-a-token-typed-secret');
		expect(await rows()).toEqual([]);

		// A refusal over a saved channel leaves it exactly as it was.
		await saveNtfy();
		const [before] = await rows();
		await saveNtfy('not a url', TOKEN_2);
		await saveNtfy('https://ntfy.sh/new-topic', 'tk_bad!');
		expect(await rows()).toEqual([before]);
	});

	it('unknown kind', async () => {
		for (const kind of ['telegram', 'x', '']) {
			expect(await saveChannel(h.db, KEY, kind, { topic: TOPIC })).toEqual({
				ok: false,
				message: UNKNOWN_KIND_MESSAGE
			});
		}
		expect(await rows()).toEqual([]);
	});
});

describe('listChannels', () => {
	it('view', async () => {
		expect(await listChannels(h.db, KEY)).toEqual({});
		await saveNtfy();
		const views = await listChannels(h.db, KEY);
		expect(views).toEqual({
			ntfy: {
				enabled: true,
				priceDrops: true,
				checkFailures: true,
				unreadable: false,
				view: { topic: TOPIC, tokenSet: true }
			}
		});
		expect(JSON.stringify(views)).not.toContain(TOKEN);
		expect(JSON.stringify(views)).not.toContain('aliceSecretToken');

		await saveNtfy('https://ntfy.sh/other-topic', '');
		expect((await listChannels(h.db, KEY)).ntfy?.view).toEqual({
			topic: 'https://ntfy.sh/other-topic',
			tokenSet: true
		});
	});

	it('swap', async () => {
		// The ntfy blob copied into the resend row: the AAD names the kind, so it fails.
		await saveNtfy();
		await saveChannel(h.db, KEY, 'resend', RESEND_FORM);
		const [ntfyRow] = await h.db.select().from(notifyChannel).where(eq(notifyChannel.kind, 'ntfy'));
		await h.db
			.update(notifyChannel)
			.set({ configEnc: ntfyRow.configEnc })
			.where(eq(notifyChannel.kind, 'resend'));

		let views: Awaited<ReturnType<typeof listChannels>> | undefined;
		await expect(
			(async () => (views = await listChannels(h.db, KEY, { log })))()
		).resolves.toBeDefined();
		expect(views?.resend).toEqual({
			enabled: true,
			priceDrops: true,
			checkFailures: false,
			unreadable: true,
			view: null
		});
		expect(views?.ntfy?.unreadable).toBe(false);
		expect(logs).toEqual(['[alerts] channel (resend) could not be decrypted']);

		// Routing skips it too, logging the same fixed line.
		logs = [];
		expect((await channelsFor(h.db, KEY, 'price_drop', { log })).map((c) => c.kind)).toEqual([
			'ntfy'
		]);
		expect(logs).toEqual(['[alerts] channel (resend) could not be decrypted']);
		expect(await loadChannelConfig(h.db, KEY, 'resend')).toBeNull();
		for (const line of logs) {
			expect(line).not.toContain('alice-own-secret-topic');
			expect(line).not.toContain(TOKEN);
			expect(line).not.toContain(ntfyRow.configEnc!);
		}
	});

	it('legacy AAD or wrong key', async () => {
		const config = JSON.stringify({ url: TOPIC, token: TOKEN });
		const sealedBy = {
			// Sealed before 02-single-user, under the per-user AAD.
			'legacy AAD': encryptSecret(KEY, config, LEGACY_AAD),
			// Sealed under another ALERTS_ENCRYPTION_KEY.
			'wrong key': encryptSecret(randomBytes(32), config, channelAad('ntfy'))
		};
		for (const [label, configEnc] of Object.entries(sealedBy)) {
			await h.db.delete(notifyChannel);
			await h.db.insert(notifyChannel).values({ kind: 'ntfy', configEnc });
			logs = [];

			let views: Awaited<ReturnType<typeof listChannels>> | undefined;
			await expect(
				(async () => (views = await listChannels(h.db, KEY, { log })))(),
				label
			).resolves.toBeDefined();
			expect(views, label).toEqual({
				ntfy: { enabled: true, priceDrops: true, checkFailures: true, unreadable: true, view: null }
			});
			expect(await channelsFor(h.db, KEY, 'price_drop', { log }), label).toEqual([]);
			expect(await channelsFor(h.db, KEY, 'check_failed', { log }), label).toEqual([]);
			expect(await loadChannelConfig(h.db, KEY, 'ntfy'), label).toBeNull();
			expect(logs, label).toEqual([
				'[alerts] channel (ntfy) could not be decrypted',
				'[alerts] channel (ntfy) could not be decrypted',
				'[alerts] channel (ntfy) could not be decrypted'
			]);
			for (const line of logs) {
				for (const secret of [TOPIC, 'alice-own-secret-topic', TOKEN, configEnc]) {
					expect(line, label).not.toContain(secret);
				}
			}
		}

		// Saving again over it seals under the current key and AAD: readable from then on.
		expect(await saveNtfy()).toEqual({ ok: true });
		expect(await loadChannelConfig(h.db, KEY, 'ntfy')).toEqual({ url: TOPIC, token: TOKEN });
	});

	it('shows a channel with no settings as unreadable without logging it', async () => {
		await h.db.insert(notifyChannel).values({ kind: 'ntfy', configEnc: null });
		expect(await listChannels(h.db, KEY, { log })).toEqual({
			ntfy: { enabled: true, priceDrops: true, checkFailures: true, unreadable: true, view: null }
		});
		expect(logs).toEqual([]);
		expect(await channelsFor(h.db, KEY, 'check_failed', { log })).toEqual([]);
		expect(logs).toEqual(['[alerts] channel (ntfy) has no settings, skipped']);
	});

	it('decrypts to something that is not JSON', async () => {
		const configEnc = encryptSecret(KEY, 'not json {', channelAad('ntfy'));
		await h.db.insert(notifyChannel).values({ kind: 'ntfy', configEnc });
		expect(await listChannels(h.db, KEY, { log })).toEqual({
			ntfy: { enabled: true, priceDrops: true, checkFailures: true, unreadable: true, view: null }
		});
		expect(await loadChannelConfig(h.db, KEY, 'ntfy')).toBeNull();
		expect(await channelsFor(h.db, KEY, 'price_drop', { log })).toEqual([]);
	});

	it('leaves out a saved channel whose type is no longer registered', async () => {
		await saveNtfy();
		const config = JSON.stringify({ value: 'gone-value' });
		await h.db.insert(notifyChannel).values({
			kind: 'gone',
			configEnc: encryptSecret(KEY, config, channelAad('gone'))
		});
		expect(Object.keys(await listChannels(h.db, KEY, { log }))).toEqual(['ntfy']);
		expect(logs).toEqual([]);
	});
});

describe('registerDriver', () => {
	it('restores what was registered before', () => {
		expect(channelKinds()).toEqual(['ntfy', 'resend', 'smtp']);

		const undoNew = registerDriver(fakeDriver('fake'));
		expect(driverFor('fake')).toBeDefined();
		expect(channelKinds()).toEqual(['ntfy', 'resend', 'smtp', 'fake']);
		undoNew();
		expect(driverFor('fake')).toBeUndefined();
		expect(channelKinds()).toEqual(['ntfy', 'resend', 'smtp']);

		const override = fakeDriver('ntfy');
		const undoOverride = registerDriver(override);
		expect(driverFor('ntfy')).toBe(override);
		undoOverride();
		expect(driverFor('ntfy')).toBe(ntfyDriver);
		expect(channelKinds()).toEqual(['ntfy', 'resend', 'smtp']);
	});
});

describe('channelsFor', () => {
	it('routing filter', async () => {
		unregister.push(registerDriver(fakeDriver('fake-b'), 'fake-b'));
		unregister.push(registerDriver(fakeDriver('fake-c'), 'fake-c'));

		// A: ntfy, drops only. B: failures only. C: both, but disabled.
		await saveNtfy(TOPIC, TOKEN, { priceDrops: true, checkFailures: false });
		await saveChannel(
			h.db,
			KEY,
			'fake-b',
			{ value: 'b' },
			{
				priceDrops: false,
				checkFailures: true
			}
		);
		await saveChannel(h.db, KEY, 'fake-c', { value: 'c' });
		expect(await setEnabled(h.db, 'fake-c', false)).toBe(true);

		const kindsOf = (routed: Awaited<ReturnType<typeof channelsFor>>) =>
			routed.map(({ kind, config }) => ({ kind, config }));
		expect(kindsOf(await channelsFor(h.db, KEY, 'price_drop'))).toEqual([
			{ kind: 'ntfy', config: { url: TOPIC, token: TOKEN } }
		]);
		expect(kindsOf(await channelsFor(h.db, KEY, 'check_failed'))).toEqual([
			{ kind: 'fake-b', config: { value: 'b' } }
		]);
		const [routedDriver] = await channelsFor(h.db, KEY, 'price_drop');
		expect(routedDriver.driver.kind).toBe('ntfy');

		// Disabling keeps everything else; re-enabling routes again.
		const before = await rows();
		expect(await setEnabled(h.db, 'ntfy', false)).toBe(true);
		const after = await rows();
		const strip = (list: typeof before) =>
			list.map(({ kind, priceDrops, checkFailures, configEnc }) => ({
				kind,
				priceDrops,
				checkFailures,
				configEnc
			}));
		expect(strip(after)).toEqual(strip(before));
		expect(after.find((row) => row.kind === 'ntfy')?.enabled).toBe(false);
		expect(await channelsFor(h.db, KEY, 'price_drop')).toEqual([]);
		await setEnabled(h.db, 'ntfy', true);
		expect(kindsOf(await channelsFor(h.db, KEY, 'price_drop'))).toEqual([
			{ kind: 'ntfy', config: { url: TOPIC, token: TOKEN } }
		]);

		expect(await setEnabled(h.db, 'resend', true)).toBe(false);
	});
});

describe('removeChannel', () => {
	it('remove', async () => {
		await saveNtfy();
		await saveChannel(h.db, KEY, 'resend', RESEND_FORM);
		for (const id of ['wa', 'wb']) {
			await h.db.insert(watch).values({
				id,
				shop: 'amazon-uk',
				productId: id,
				canonicalUrl: `https://www.amazon.co.uk/dp/${id}`
			});
		}
		await h.db.insert(priceDropDelivery).values([
			{ watchId: 'wa', kind: 'ntfy', targetPence: 1000 },
			{ watchId: 'wb', kind: 'ntfy', targetPence: 1000 },
			{ watchId: 'wa', kind: 'resend', targetPence: 1000 }
		]);

		await removeChannel(h.db, 'ntfy');

		expect((await rows()).map((row) => row.kind)).toEqual(['resend']);
		expect(Object.keys(await listChannels(h.db, KEY))).toEqual(['resend']);
		expect(
			await h.db
				.select({ watchId: priceDropDelivery.watchId, kind: priceDropDelivery.kind })
				.from(priceDropDelivery)
		).toEqual([{ watchId: 'wa', kind: 'resend' }]);

		// Removing a kind with nothing saved is a no-op.
		await removeChannel(h.db, 'smtp');
		expect((await rows()).map((row) => row.kind)).toEqual(['resend']);
	});
});
