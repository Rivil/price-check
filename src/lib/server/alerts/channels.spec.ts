import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { notifyChannel, priceDropDelivery, watch } from '../db/schema.ts';
import { createAuthHarness, type AuthHarness } from '../testing/auth-harness.ts';
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

let h: AuthHarness;
let alice: string;
let bob: string;
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
	h = await createAuthHarness();
	alice = (await h.createUser({ email: 'alice@example.test' })).id;
	bob = (await h.createUser({ email: 'bob@example.test' })).id;
	logs = [];
});
afterEach(() => {
	for (const undo of unregister.reverse()) undo();
	unregister = [];
	h.cleanup();
});

const saveNtfy = (
	userId: string,
	topic = TOPIC,
	token = TOKEN,
	routing?: Parameters<typeof saveChannel>[5]
) => saveChannel(h.db, KEY, userId, 'ntfy', { topic, token }, routing);

async function rows(userId?: string) {
	const all = await h.db.select().from(notifyChannel);
	return userId === undefined ? all : all.filter((row) => row.userId === userId);
}

describe('saveChannel', () => {
	it('at rest', async () => {
		expect(await saveNtfy(alice)).toEqual({ ok: true });
		const [row] = await rows(alice);
		expect(row.configEnc).toMatch(/^v1:/);
		for (const secret of [TOPIC, 'alice-own-secret-topic', TOKEN]) {
			expect(row.configEnc).not.toContain(secret);
		}

		h.db.$client.close();
		const bytes = [h.file, `${h.file}-wal`, `${h.file}-journal`]
			.filter((path) => existsSync(path))
			.map((path) => readFileSync(path).toString('latin1'))
			.join('');
		expect(bytes.length).toBeGreaterThan(0);
		for (const secret of ['alice-own-secret-topic', 'ntfy.sh', TOKEN, 'aliceSecretToken']) {
			expect(bytes.includes(secret), secret).toBe(false);
		}
	});

	it('resend at rest', async () => {
		expect(await saveChannel(h.db, KEY, alice, 'resend', RESEND_FORM)).toEqual({ ok: true });
		const [row] = await rows(alice);
		expect(row.configEnc).toMatch(/^v1:/);
		expect(row.configEnc).not.toContain(RESEND_KEY);
		expect(await loadChannelConfig(h.db, KEY, alice, 'resend')).toEqual({
			apiKey: RESEND_KEY,
			from: 'alerts@alice-shop.test',
			to: 'alice@example.test'
		});

		// Only the key: the recipient is alice's login email, stored in the user table
		// in plain text anyway.
		h.db.$client.close();
		const bytes = [h.file, `${h.file}-wal`, `${h.file}-journal`]
			.filter((path) => existsSync(path))
			.map((path) => readFileSync(path).toString('latin1'))
			.join('');
		expect(bytes.length).toBeGreaterThan(0);
		for (const secret of [RESEND_KEY, 'AliceResend_9fQ2xLm7Tz0kWv3']) {
			expect(bytes.includes(secret), secret).toBe(false);
		}
	});

	it('resend defaults', async () => {
		await saveChannel(h.db, KEY, alice, 'resend', RESEND_FORM);
		expect(await rows(alice)).toMatchObject([
			{ kind: 'resend', enabled: true, priceDrops: true, checkFailures: false }
		]);
		const views = await listChannels(h.db, KEY, alice);
		expect(views.resend?.view).toEqual({
			from: 'alerts@alice-shop.test',
			to: 'alice@example.test',
			keySet: true
		});
		expect(JSON.stringify(views)).not.toContain(RESEND_KEY);
	});

	it('smtp at rest', async () => {
		expect(await saveChannel(h.db, KEY, alice, 'smtp', SMTP_FORM)).toEqual({ ok: true });
		const [row] = await rows(alice);
		expect(row.configEnc).toMatch(/^v1:/);
		expect(row.configEnc).not.toContain(SMTP_PASSWORD);
		expect(await loadChannelConfig(h.db, KEY, alice, 'smtp')).toEqual({
			host: 'smtp.alice-mail.test',
			port: 587,
			username: 'alice@alice-mail.test',
			password: SMTP_PASSWORD,
			from: 'alerts@alice-shop.test',
			to: 'alice@example.test'
		});

		h.db.$client.close();
		const bytes = [h.file, `${h.file}-wal`, `${h.file}-journal`]
			.filter((path) => existsSync(path))
			.map((path) => readFileSync(path).toString('latin1'))
			.join('');
		expect(bytes.length).toBeGreaterThan(0);
		for (const secret of [SMTP_PASSWORD, 'qzpx', 'vtrw mkdl', 'hsye']) {
			expect(bytes.includes(secret), secret).toBe(false);
		}
	});

	it('smtp defaults', async () => {
		await saveChannel(h.db, KEY, alice, 'smtp', SMTP_FORM);
		expect(await rows(alice)).toMatchObject([
			{ kind: 'smtp', enabled: true, priceDrops: true, checkFailures: false }
		]);
		const views = await listChannels(h.db, KEY, alice);
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

		// So it is routed price drops and not failed checks, until the user ticks them.
		expect(await channelsFor(h.db, KEY, alice, 'check_failed')).toEqual([]);
		expect((await channelsFor(h.db, KEY, alice, 'price_drop')).map((c) => c.kind)).toEqual([
			'smtp'
		]);
	});

	it('write-only', async () => {
		await saveNtfy(alice);
		expect(await loadChannelConfig(h.db, KEY, alice, 'ntfy')).toEqual({ url: TOPIC, token: TOKEN });

		// Blank (or whitespace) keeps the saved token, even while the topic changes.
		for (const blank of ['', '   ']) {
			await saveNtfy(alice, 'https://ntfy.sh/alice-moved', blank);
			expect(await loadChannelConfig(h.db, KEY, alice, 'ntfy')).toEqual({
				url: 'https://ntfy.sh/alice-moved',
				token: TOKEN
			});
		}

		await saveNtfy(alice, TOPIC, TOKEN_2);
		expect(await loadChannelConfig(h.db, KEY, alice, 'ntfy')).toEqual({
			url: TOPIC,
			token: TOKEN_2
		});
		expect(await rows(alice)).toHaveLength(1);
	});

	it('defaults', async () => {
		await saveNtfy(alice);
		expect(await rows(alice)).toMatchObject([
			{ kind: 'ntfy', enabled: true, priceDrops: true, checkFailures: true }
		]);

		// A re-save without routing keeps the saved kinds and the enabled state.
		await saveNtfy(alice, TOPIC, '', { priceDrops: false, checkFailures: true });
		await setEnabled(h.db, alice, 'ntfy', false);
		await saveNtfy(alice, TOPIC, '');
		expect(await rows(alice)).toMatchObject([
			{ enabled: false, priceDrops: false, checkFailures: true }
		]);
	});

	it('kinds', async () => {
		const none = { priceDrops: false, checkFailures: false };
		expect(await saveNtfy(alice, TOPIC, TOKEN, none)).toEqual({
			ok: false,
			message: NO_KINDS_MESSAGE
		});
		expect(await rows(alice)).toEqual([]);

		await saveNtfy(alice, TOPIC, TOKEN, { priceDrops: true, checkFailures: false });
		const [before] = await rows(alice);
		expect(await saveNtfy(alice, 'https://ntfy.sh/other', TOKEN_2, none)).toEqual({
			ok: false,
			message: NO_KINDS_MESSAGE
		});
		expect(await rows(alice)).toEqual([before]);
	});

	it('invalid', async () => {
		const badTopic = parseTopicUrl('http://ntfy.sh/plain-http');
		const badToken = parseToken('not-a-token-typed-secret');
		if (badTopic.ok || badToken.ok) throw new Error('fixtures should be invalid');

		expect(await saveNtfy(alice, 'http://ntfy.sh/plain-http')).toEqual({
			ok: false,
			message: badTopic.message
		});
		const tokenResult = await saveNtfy(alice, TOPIC, 'not-a-token-typed-secret');
		expect(tokenResult).toEqual({ ok: false, message: badToken.message });
		expect(JSON.stringify(tokenResult)).not.toContain('not-a-token-typed-secret');
		expect(await rows()).toEqual([]);

		// A refusal over a saved channel leaves it exactly as it was.
		await saveNtfy(alice);
		const [before] = await rows(alice);
		await saveNtfy(alice, 'not a url', TOKEN_2);
		await saveNtfy(alice, 'https://ntfy.sh/new-topic', 'tk_bad!');
		expect(await rows(alice)).toEqual([before]);
	});

	it('unknown kind', async () => {
		for (const kind of ['telegram', 'x', '']) {
			expect(await saveChannel(h.db, KEY, alice, kind, { topic: TOPIC })).toEqual({
				ok: false,
				message: UNKNOWN_KIND_MESSAGE
			});
		}
		expect(await rows()).toEqual([]);
	});
});

describe('listChannels', () => {
	it('view', async () => {
		expect(await listChannels(h.db, KEY, alice)).toEqual({});
		await saveNtfy(alice);
		const views = await listChannels(h.db, KEY, alice);
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

		await saveNtfy(bob, 'https://ntfy.sh/bob-topic', '');
		expect((await listChannels(h.db, KEY, bob)).ntfy?.view).toEqual({
			topic: 'https://ntfy.sh/bob-topic',
			tokenSet: false
		});
		expect(JSON.stringify(await listChannels(h.db, KEY, alice))).not.toContain('bob-topic');
	});

	it('swap', async () => {
		await saveNtfy(alice);
		await saveNtfy(bob, 'https://ntfy.sh/bob-topic', '');
		const [aliceRow] = await rows(alice);
		await h.db
			.update(notifyChannel)
			.set({ configEnc: aliceRow.configEnc })
			.where(eq(notifyChannel.userId, bob));

		let views: Awaited<ReturnType<typeof listChannels>> | undefined;
		await expect(
			(async () => (views = await listChannels(h.db, KEY, bob, { log })))()
		).resolves.toBeDefined();
		expect(views).toEqual({
			ntfy: { enabled: true, priceDrops: true, checkFailures: true, unreadable: true, view: null }
		});
		expect(logs).toEqual([`[alerts] channel ${bob} (ntfy) could not be decrypted`]);

		// Routing skips it too, logging the same fixed line.
		logs = [];
		expect(await channelsFor(h.db, KEY, bob, 'price_drop', { log })).toEqual([]);
		expect(logs).toEqual([`[alerts] channel ${bob} (ntfy) could not be decrypted`]);
		expect(await loadChannelConfig(h.db, KEY, bob, 'ntfy')).toBeNull();
		for (const line of logs) {
			expect(line).not.toContain('alice-own-secret-topic');
			expect(line).not.toContain(TOKEN);
			expect(line).not.toContain(aliceRow.configEnc!);
		}
	});

	it('shows a not-yet-backfilled channel as unreadable without logging it', async () => {
		await h.db.insert(notifyChannel).values({ userId: alice, kind: 'ntfy', configEnc: null });
		expect(await listChannels(h.db, KEY, alice, { log })).toEqual({
			ntfy: { enabled: true, priceDrops: true, checkFailures: true, unreadable: true, view: null }
		});
		expect(logs).toEqual([]);
		expect(await channelsFor(h.db, KEY, alice, 'check_failed', { log })).toEqual([]);
		expect(logs).toEqual([`[alerts] channel ${alice} (ntfy) has no settings yet, skipped`]);
	});

	it('decrypts to something that is not JSON', async () => {
		const configEnc = encryptSecret(KEY, 'not json {', channelAad(alice, 'ntfy'));
		await h.db.insert(notifyChannel).values({ userId: alice, kind: 'ntfy', configEnc });
		expect(await listChannels(h.db, KEY, alice, { log })).toEqual({
			ntfy: { enabled: true, priceDrops: true, checkFailures: true, unreadable: true, view: null }
		});
		expect(await loadChannelConfig(h.db, KEY, alice, 'ntfy')).toBeNull();
		expect(await channelsFor(h.db, KEY, alice, 'price_drop', { log })).toEqual([]);
	});

	it('leaves out a saved channel whose type is no longer registered', async () => {
		await saveNtfy(alice);
		const config = JSON.stringify({ value: 'gone-value' });
		await h.db.insert(notifyChannel).values({
			userId: alice,
			kind: 'gone',
			configEnc: encryptSecret(KEY, config, channelAad(alice, 'gone'))
		});
		expect(Object.keys(await listChannels(h.db, KEY, alice, { log }))).toEqual(['ntfy']);
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
		await saveNtfy(alice, TOPIC, TOKEN, { priceDrops: true, checkFailures: false });
		await saveChannel(
			h.db,
			KEY,
			alice,
			'fake-b',
			{ value: 'b' },
			{
				priceDrops: false,
				checkFailures: true
			}
		);
		await saveChannel(h.db, KEY, alice, 'fake-c', { value: 'c' });
		expect(await setEnabled(h.db, alice, 'fake-c', false)).toBe(true);
		// Bob's channels never route to alice.
		await saveNtfy(bob, 'https://ntfy.sh/bob-topic', '');

		const kindsOf = (routed: Awaited<ReturnType<typeof channelsFor>>) =>
			routed.map(({ kind, config }) => ({ kind, config }));
		expect(kindsOf(await channelsFor(h.db, KEY, alice, 'price_drop'))).toEqual([
			{ kind: 'ntfy', config: { url: TOPIC, token: TOKEN } }
		]);
		expect(kindsOf(await channelsFor(h.db, KEY, alice, 'check_failed'))).toEqual([
			{ kind: 'fake-b', config: { value: 'b' } }
		]);
		const [routedDriver] = await channelsFor(h.db, KEY, alice, 'price_drop');
		expect(routedDriver.driver.kind).toBe('ntfy');

		// Disabling keeps everything else; re-enabling routes again.
		const before = await rows(alice);
		expect(await setEnabled(h.db, alice, 'ntfy', false)).toBe(true);
		const after = await rows(alice);
		const strip = (list: typeof before) =>
			list.map(({ kind, priceDrops, checkFailures, configEnc }) => ({
				kind,
				priceDrops,
				checkFailures,
				configEnc
			}));
		expect(strip(after)).toEqual(strip(before));
		expect(after.find((row) => row.kind === 'ntfy')?.enabled).toBe(false);
		expect(await channelsFor(h.db, KEY, alice, 'price_drop')).toEqual([]);
		await setEnabled(h.db, alice, 'ntfy', true);
		expect(kindsOf(await channelsFor(h.db, KEY, alice, 'price_drop'))).toEqual([
			{ kind: 'ntfy', config: { url: TOPIC, token: TOKEN } }
		]);

		expect(await setEnabled(h.db, alice, 'resend', true)).toBe(false);
	});
});

describe('removeChannel', () => {
	it('remove', async () => {
		await saveNtfy(alice);
		await saveNtfy(bob, 'https://ntfy.sh/bob-topic', '');
		for (const [id, owner] of [
			['wa', alice],
			['wb', bob]
		] as const) {
			await h.db.insert(watch).values({
				id,
				userId: owner,
				shop: 'amazon-uk',
				productId: id,
				canonicalUrl: `https://www.amazon.co.uk/dp/${id}`
			});
			await h.db
				.insert(priceDropDelivery)
				.values({ watchId: id, kind: 'ntfy', userId: owner, targetPence: 1000 });
		}

		await removeChannel(h.db, alice, 'ntfy');

		expect(await rows(alice)).toEqual([]);
		expect(await listChannels(h.db, KEY, alice)).toEqual({});
		expect(
			await h.db.select().from(priceDropDelivery).where(eq(priceDropDelivery.userId, alice))
		).toEqual([]);
		expect(await rows(bob)).toHaveLength(1);
		expect(
			await h.db
				.select({ watchId: priceDropDelivery.watchId })
				.from(priceDropDelivery)
				.where(and(eq(priceDropDelivery.userId, bob), eq(priceDropDelivery.kind, 'ntfy')))
		).toEqual([{ watchId: 'wb' }]);
	});
});
