import { randomBytes } from 'node:crypto';
import { simpleParser } from 'mailparser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { priceDropDelivery, watch } from '../db/schema.ts';
import { createTestDb, type TestDb } from '../testing/test-db.ts';
import { startSmtpServer, type FakeSmtpServer } from '../testing/smtp-server.ts';
import { failure } from '../shops/types.ts';
import type { ChannelDriver } from './channel.ts';
import {
	registerDriver,
	removeChannel,
	saveChannel,
	type AnyDriver,
	type Routing
} from './channels.ts';
import { setAlertsKey } from './crypto.ts';
import { liveAfterFailure, liveAfterSuccess } from './live.ts';
import { smtpDriver, type SmtpConfig } from './smtp.ts';

// Global fetch is stubbed: nothing reaches a real ntfy server or api.resend.com.
// SMTP sends go to the in-process fake server on 127.0.0.1.

const KEY = randomBytes(32);
let h: TestDb;
const fetch = vi.fn(async () => new Response('{}', { status: 200 }));

beforeEach(async () => {
	h = await createTestDb();
	setAlertsKey(KEY);
	await saveChannel(h.db, KEY, 'ntfy', { topic: 'https://ntfy.sh/alice-topic' });
	fetch.mockClear();
	vi.stubGlobal('fetch', fetch);
});
afterEach(() => {
	vi.unstubAllGlobals();
	h.dispose();
});
let undoSmtp: (() => void) | undefined;
let smtpServer: FakeSmtpServer | undefined;
afterEach(async () => {
	undoSmtp?.();
	undoSmtp = undefined;
	await smtpServer?.close();
	smtpServer = undefined;
});

const addWatch = (fields: Partial<typeof watch.$inferInsert> = {}) =>
	h.db.insert(watch).values({
		id: 'w1',
		shop: 'amazon-uk',
		productId: 'B0ABC12345',
		canonicalUrl: 'https://www.amazon.co.uk/dp/B0ABC12345',
		title: 'Acme Kettle',
		pricePence: 1500,
		targetPence: 2000,
		...fields
	});

const RESEND_KEY = 're_AliceResend_9fQ2xLm7Tz0kWv3'; // key-shaped, not a real one

/** Swaps the ntfy channel for a Resend one, so every fetch is a Resend send. */
async function useResend(routing?: Routing, apiKey = RESEND_KEY) {
	await removeChannel(h.db, 'ntfy');
	const form = { api_key: apiKey, from: 'alerts@alice-shop.test', to: 'alice@example.test' };
	expect(await saveChannel(h.db, KEY, 'resend', form, routing)).toEqual({ ok: true });
}

const SMTP_PASSWORD = 'qzpx vtrw mkdl hsye'; // app-password-shaped, not a real one

/**
 * Adds an SMTP channel on a fake server, saved without routing. live.ts hands
 * drivers no CA, so the real SMTP driver is registered with the fake server's added.
 */
async function useSmtp(): Promise<FakeSmtpServer> {
	const server = await startSmtpServer();
	smtpServer = server;
	const trusting: ChannelDriver<SmtpConfig> = {
		...smtpDriver,
		send: (config, alert, deps) => smtpDriver.send(config, alert, { ...deps, tlsCa: server.ca })
	};
	undoSmtp = registerDriver(trusting as AnyDriver);
	const form = {
		host: server.host,
		port: String(server.port),
		username: 'alice@alice-mail.test',
		password: SMTP_PASSWORD,
		from: 'alerts@alice-shop.test',
		to: 'alice@example.test'
	};
	expect(await saveChannel(h.db, KEY, 'smtp', form)).toEqual({ ok: true });
	return server;
}

/** The one fetch call's target and its JSON body. */
function onlySend() {
	expect(fetch).toHaveBeenCalledOnce();
	const [target, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
	return { target, init, body: JSON.parse(String(init.body)) as unknown };
}

describe('liveAfterSuccess', () => {
	it('live', async () => {
		await addWatch();

		expect(await liveAfterSuccess(h.db)('w1')).toEqual({
			outcome: 'sent',
			channels: { ntfy: 'sent' }
		});

		expect(fetch).toHaveBeenCalledOnce();
		const [target, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
		expect(target).toBe('https://ntfy.sh/');
		expect(JSON.parse(String(init.body))).toEqual({
			topic: 'alice-topic',
			title: 'Price drop: Acme Kettle',
			message: 'Acme Kettle is now £15.00, at or below your £20.00 target.',
			click: 'https://www.amazon.co.uk/dp/B0ABC12345',
			priority: 5
		});
		expect(await h.db.select().from(priceDropDelivery)).toMatchObject([
			{ watchId: 'w1', kind: 'ntfy', targetPence: 2000 }
		]);

		// Once per drop: the same state sends nothing more.
		await liveAfterSuccess(h.db)('w1');
		expect(fetch).toHaveBeenCalledOnce();
	});

	it('key', async () => {
		await addWatch();

		// The installed key is read on each call: under another key the saved
		// channel cannot be opened, so nothing is sent.
		setAlertsKey(randomBytes(32));
		expect(await liveAfterSuccess(h.db)('w1')).toEqual({ outcome: 'no_channel', channels: {} });
		expect(fetch).not.toHaveBeenCalled();

		setAlertsKey(KEY);
		expect(await liveAfterSuccess(h.db)('w1')).toMatchObject({ outcome: 'sent' });
		expect(fetch).toHaveBeenCalledOnce();
	});

	it('overlap', async () => {
		await addWatch();
		let answer!: (response: Response) => void;
		fetch.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));

		// The scheduler and "Check now" each build their own hook.
		const scheduled = liveAfterSuccess(h.db)('w1');
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
		expect(await liveAfterSuccess(h.db)('w1')).toEqual({ outcome: 'in_progress', channels: {} });

		answer(new Response('{}', { status: 200 }));
		expect(await scheduled).toMatchObject({ outcome: 'sent' });
		expect(fetch).toHaveBeenCalledOnce();
	});

	it('live resend', async () => {
		await useResend();
		await addWatch();

		expect(await liveAfterSuccess(h.db)('w1')).toEqual({
			outcome: 'sent',
			channels: { resend: 'sent' }
		});
		const { target, init, body } = onlySend();
		expect(target).toBe('https://api.resend.com/emails');
		expect(init.method).toBe('POST');
		expect(body).toEqual({
			from: 'Price check <alerts@alice-shop.test>',
			to: ['alice@example.test'],
			subject: 'Price drop: Acme Kettle',
			text: 'Acme Kettle is now £15.00, at or below your £20.00 target.\n\nhttps://www.amazon.co.uk/dp/B0ABC12345'
		});
		expect(await h.db.select().from(priceDropDelivery)).toMatchObject([
			{ watchId: 'w1', kind: 'resend', targetPence: 2000 }
		]);
	});
});

describe('liveAfterFailure', () => {
	it('live', async () => {
		await addWatch({ pricePence: null, targetPence: null });

		expect(
			await liveAfterFailure(h.db)('w1', failure('unavailable', 'currently unavailable'))
		).toEqual({ outcome: 'sent', channels: { ntfy: 'sent' } });

		expect(fetch).toHaveBeenCalledOnce();
		const [target, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
		expect(target).toBe('https://ntfy.sh/');
		expect(JSON.parse(String(init.body))).toEqual({
			topic: 'alice-topic',
			title: 'Check failed: Acme Kettle',
			message: "Couldn't check Acme Kettle: currently unavailable.",
			click: 'https://www.amazon.co.uk/dp/B0ABC12345',
			priority: 2
		});
		expect(await h.db.select().from(priceDropDelivery)).toEqual([]);
	});

	it('live resend failure', async () => {
		await addWatch({ pricePence: null, targetPence: null });
		const unavailable = failure('unavailable', 'currently unavailable');

		// A new Resend channel is off for failed checks: nothing is sent.
		await useResend();
		expect(await liveAfterFailure(h.db)('w1', unavailable)).toEqual({
			outcome: 'no_channel',
			channels: {}
		});
		expect(fetch).not.toHaveBeenCalled();

		// Ticked (the key left blank keeps the saved one): the failure is emailed.
		await useResend({ priceDrops: true, checkFailures: true }, '');
		expect(await liveAfterFailure(h.db)('w1', unavailable)).toEqual({
			outcome: 'sent',
			channels: { resend: 'sent' }
		});
		const { target, init, body } = onlySend();
		expect(target).toBe('https://api.resend.com/emails');
		expect(init.method).toBe('POST');
		expect(init.headers).toMatchObject({ authorization: `Bearer ${RESEND_KEY}` });
		expect(body).toEqual({
			from: 'Price check <alerts@alice-shop.test>',
			to: ['alice@example.test'],
			subject: 'Check failed: Acme Kettle',
			text: "Couldn't check Acme Kettle: currently unavailable.\n\nhttps://www.amazon.co.uk/dp/B0ABC12345"
		});
	});
});

describe('smtp', () => {
	it('live smtp', async () => {
		const smtp = await useSmtp();
		await addWatch();

		// The ntfy channel (both kinds) and the new SMTP one (drops only) both get the drop.
		expect(await liveAfterSuccess(h.db)('w1')).toEqual({
			outcome: 'sent',
			channels: { ntfy: 'sent', smtp: 'sent' }
		});
		expect(smtp.messages).toHaveLength(1);
		const [message] = smtp.messages;
		expect(message.to).toEqual(['alice@example.test']);
		const email = await simpleParser(message.raw);
		expect(email.from?.value).toEqual([{ name: 'Price check', address: 'alerts@alice-shop.test' }]);
		expect(email.subject).toBe('Price drop: Acme Kettle');
		// mailparser ends a decoded text part with one line break of its own.
		expect(email.text).toBe(
			'Acme Kettle is now £15.00, at or below your £20.00 target.\n\nhttps://www.amazon.co.uk/dp/B0ABC12345\n'
		);
		const rows = await h.db.select().from(priceDropDelivery);
		expect(rows.map((row) => row.kind).sort()).toEqual(['ntfy', 'smtp']);
		expect(rows).toMatchObject([{ targetPence: 2000 }, { targetPence: 2000 }]);

		// A failed check: ntfy is set for those, SMTP (failed checks off) is not.
		fetch.mockClear();
		expect(
			await liveAfterFailure(h.db)('w1', failure('unavailable', 'currently unavailable'))
		).toEqual({ outcome: 'sent', channels: { ntfy: 'sent' } });
		expect(fetch).toHaveBeenCalledOnce();
		expect(smtp.messages).toHaveLength(1);
		expect(smtp.connections).toHaveLength(1);
	});
});
