import { randomBytes } from 'node:crypto';
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
	type Mock,
	type MockInstance
} from 'vitest';
import { eq } from 'drizzle-orm';
import { notifyChannel, priceDropDelivery, watch } from '../db/schema.ts';
import { createTestDb, type TestDb } from '../testing/test-db.ts';
import { setTarget } from '../watches.ts';
import { failure } from '../shops/types.ts';
import { startSmtpServer, type FakeSmtpServer } from '../testing/smtp-server.ts';
import type { ChannelDriver, ChannelKind, SendResult } from './channel.ts';
import {
	registerDriver,
	removeChannel,
	saveChannel,
	setEnabled,
	type AnyDriver,
	type Routing
} from './channels.ts';
import { AlertsKeyError } from './crypto.ts';
import { ntfyDriver } from './ntfy.ts';
import { smtpDriver, type SmtpConfig } from './smtp.ts';
import { alertAfterFailure, alertAfterSuccess, type AlertDeps } from './alerts.ts';
import * as alertsModule from './alerts.ts';

// Every driver's send is a stub — the real ntfy driver's is spied on, the others are
// registered fakes — and the injected fetch must never be called: nothing here
// reaches a real server. The exceptions, 'ntfy and resend' and 'ntfy, resend and
// smtp', run the real drivers over their own fetch stub, routed by host, and SMTP
// against the in-process fake server on 127.0.0.1.

const KEY = randomBytes(32);
const TOPIC = 'https://ntfy.sh/alice-secret-topic';
const TOKEN = 'tk_abcdefghijklmnopqrstuvwxyz012'; // token-shaped, not a real one
const NOW = new Date('2026-11-02T12:00:00Z');
const DROPS: Routing = { priceDrops: true, checkFailures: false };
const FAILURES: Routing = { priceDrops: false, checkFailures: true };
const BOTH: Routing = { priceDrops: true, checkFailures: true };
const blocked = failure('blocked', 'Amazon served a robot-check (captcha) page');

type Send = AnyDriver['send'];
type SendStub = MockInstance<Send>;

let h: TestDb;
let logs: string[];
let fetch: Mock<AlertDeps['fetch']>;
let ntfySend: SendStub;
let unregister: (() => void)[] = [];

beforeEach(async () => {
	h = await createTestDb();
	logs = [];
	fetch = vi.fn<AlertDeps['fetch']>();
	ntfySend = vi.spyOn(ntfyDriver as AnyDriver, 'send').mockResolvedValue({ ok: true });
});
afterEach(() => {
	for (const undo of unregister.reverse()) undo();
	unregister = [];
	const fetched = fetch.mock.calls.length;
	vi.restoreAllMocks();
	h.dispose();
	expect(fetched, 'the injected fetch was called').toBe(0);
});
const smtpServers: FakeSmtpServer[] = [];
afterEach(async () => {
	await Promise.all(smtpServers.splice(0).map((server) => server.close()));
});

/**
 * Registers the real SMTP driver with only the fake server's CA added to what it
 * trusts: alerts.ts hands drivers no CA, and the fake server's certificate is a test one.
 */
async function realSmtp(): Promise<FakeSmtpServer> {
	const server = await startSmtpServer();
	smtpServers.push(server);
	const trusting: ChannelDriver<SmtpConfig> = {
		...smtpDriver,
		send: (config, alert, sendDeps) =>
			smtpDriver.send(config, alert, { ...sendDeps, tlsCa: server.ca })
	};
	unregister.push(registerDriver(trusting as AnyDriver));
	return server;
}

/** Registers another channel type under `kind` and returns its send stub. */
function fakeKind(kind: string): SendStub {
	const send = vi.fn<Send>(async () => ({ ok: true }));
	const driver: ChannelDriver<{ value: string }> = {
		kind: kind as ChannelKind,
		defaultKinds: ['price_drop', 'check_failed'],
		parseConfig: (form) =>
			form.value ? { ok: true, config: { value: form.value } } : { ok: false, message: 'value' },
		view: (config) => ({ value: config.value }),
		send
	};
	unregister.push(registerDriver(driver as AnyDriver, kind));
	return send;
}

async function saveNtfy(routing: Routing = BOTH) {
	const saved = await saveChannel(h.db, KEY, 'ntfy', { topic: TOPIC, token: TOKEN }, routing);
	expect(saved).toEqual({ ok: true });
}

async function saveFake(kind: string, routing: Routing = BOTH) {
	expect(await saveChannel(h.db, KEY, kind, { value: kind }, routing)).toEqual({ ok: true });
}

async function addWatch(id: string, fields: Partial<typeof watch.$inferInsert> = {}) {
	await h.db.insert(watch).values({
		id,
		shop: 'amazon-uk',
		// One product per watch: the (shop, product_id) unique index allows no repeats.
		productId: `B0${id}`.padEnd(10, '0'),
		canonicalUrl: `https://www.amazon.co.uk/dp/${id}`,
		title: 'Acme Kettle™',
		pricePence: 1999,
		targetPence: 2000,
		...fields
	});
}

const setPrice = (id: string, pricePence: number) =>
	h.db.update(watch).set({ pricePence }).where(eq(watch.id, id));

/** Delivery rows as (watch, kind, target), sorted, for exact comparisons. */
async function deliveries(watchId?: string) {
	const rows = await h.db.select().from(priceDropDelivery);
	return rows
		.filter((row) => watchId === undefined || row.watchId === watchId)
		.map(({ watchId, kind, targetPence }) => ({ watchId, kind, targetPence }))
		.sort((a, b) => `${a.watchId} ${a.kind}`.localeCompare(`${b.watchId} ${b.kind}`));
}

function deps(): AlertDeps {
	return { key: () => KEY, fetch, now: () => NOW, log: (message) => logs.push(message) };
}

/** The next call to `send` stays pending until the returned release(), then answers result. */
function hold(send: SendStub, result: SendResult = { ok: true }): () => void {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	send.mockImplementationOnce(async () => {
		await gate;
		return result;
	});
	return () => release();
}

/** The alert kinds a send stub was called with, in order. */
const sentKinds = (send: SendStub) => send.mock.calls.map(([, alert]) => alert.kind);

describe('legacy topic store', () => {
	it('legacy exports gone', () => {
		// Channels live in the encrypted channel store now; the plaintext single-topic
		// helpers must not come back.
		const exported = Object.keys(alertsModule);
		for (const name of ['getChannel', 'getTopic', 'saveTopic', 'clearTopic']) {
			expect(exported, name).not.toContain(name);
		}
		expect(exported).toEqual(expect.arrayContaining(['alertAfterSuccess', 'alertAfterFailure']));
	});
});

describe('alertAfterSuccess', () => {
	it('routing', async () => {
		const fake = fakeKind('fake');
		const failuresOnly = fakeKind('failures-only');
		const disabled = fakeKind('disabled');
		await saveNtfy();
		await saveFake('fake');
		await saveFake('failures-only', FAILURES);
		await saveFake('disabled');
		expect(await setEnabled(h.db, 'disabled', false)).toBe(true);
		await addWatch('w1');

		expect(await alertAfterSuccess(h.db, 'w1', deps())).toEqual({
			outcome: 'sent',
			channels: { ntfy: 'sent', fake: 'sent' }
		});
		expect(ntfySend).toHaveBeenCalledOnce();
		expect(fake).toHaveBeenCalledOnce();
		expect(sentKinds(ntfySend)).toEqual(['price_drop']);
		expect(sentKinds(fake)).toEqual(['price_drop']);
		expect(failuresOnly).not.toHaveBeenCalled();
		expect(disabled).not.toHaveBeenCalled();
		expect(await deliveries()).toEqual([
			{ watchId: 'w1', kind: 'fake', targetPence: 2000 },
			{ watchId: 'w1', kind: 'ntfy', targetPence: 2000 }
		]);

		// The same price on the next check: every channel already has this drop.
		expect(await alertAfterSuccess(h.db, 'w1', deps())).toEqual({
			outcome: 'already_sent',
			channels: { ntfy: 'already_sent', fake: 'already_sent' }
		});
		for (const send of [ntfySend, fake]) expect(send).toHaveBeenCalledOnce();
		for (const send of [failuresOnly, disabled]) expect(send).not.toHaveBeenCalled();
	});

	it('once per drop', async () => {
		await saveNtfy();
		await addWatch('w1');
		const check = async () => (await alertAfterSuccess(h.db, 'w1', deps())).outcome;

		// At target with an enabled ntfy channel: sent exactly once, however many checks.
		expect(await check()).toBe('sent');
		expect(await check()).toBe('already_sent');
		expect(await check()).toBe('already_sent');
		expect(ntfySend).toHaveBeenCalledOnce();

		// A changed target re-arms: once more, then quiet again.
		expect(await setTarget(h.db, 'w1', '25.00')).toMatchObject({ kind: 'updated' });
		expect(await check()).toBe('sent');
		expect(await check()).toBe('already_sent');
		expect(ntfySend).toHaveBeenCalledTimes(2);

		// The channel removed and added again: its deliveries went with it, so once more.
		await removeChannel(h.db, 'ntfy');
		expect(await deliveries()).toEqual([]);
		await saveNtfy();
		expect(await check()).toBe('sent');
		expect(await check()).toBe('already_sent');
		expect(ntfySend).toHaveBeenCalledTimes(3);

		// Disabled: a re-armed drop sends nothing.
		expect(await setEnabled(h.db, 'ntfy', false)).toBe(true);
		expect(await setTarget(h.db, 'w1', '30.00')).toMatchObject({ kind: 'updated' });
		expect(await check()).toBe('no_channel');
		expect(ntfySend).toHaveBeenCalledTimes(3);
		expect(sentKinds(ntfySend)).toEqual(['price_drop', 'price_drop', 'price_drop']);
	});

	it('alert', async () => {
		await saveNtfy();
		await addWatch('w1');
		await alertAfterSuccess(h.db, 'w1', deps());

		// The ntfy driver gets its decrypted config and the injected fetch.
		expect(ntfySend).toHaveBeenCalledExactlyOnceWith(
			{ url: TOPIC, token: TOKEN },
			{
				kind: 'price_drop',
				title: 'Price drop: Acme Kettle™',
				message: 'Acme Kettle™ is now £19.99, at or below your £20.00 target.',
				click: 'https://www.amazon.co.uk/dp/w1'
			},
			{ fetch }
		);
		const [row] = await h.db.select().from(priceDropDelivery);
		expect(row).toEqual({ watchId: 'w1', kind: 'ntfy', targetPence: 2000, deliveredAt: NOW });

		// Exactly at target counts as a drop; an untitled watch is named by its URL.
		await addWatch('w2', { title: null, pricePence: 2000 });
		expect((await alertAfterSuccess(h.db, 'w2', deps())).outcome).toBe('sent');
		expect(ntfySend).toHaveBeenLastCalledWith(
			{ url: TOPIC, token: TOKEN },
			{
				kind: 'price_drop',
				title: 'Price drop: https://www.amazon.co.uk/dp/w2',
				message: 'https://www.amazon.co.uk/dp/w2 is now £20.00, at or below your £20.00 target.',
				click: 'https://www.amazon.co.uk/dp/w2'
			},
			{ fetch }
		);
	});

	it('retry only failed', async () => {
		const fake = fakeKind('fake');
		await saveNtfy();
		await saveFake('fake');
		await addWatch('w1');
		fake.mockResolvedValueOnce({ ok: false, reason: 'refused', status: 500 });

		expect(await alertAfterSuccess(h.db, 'w1', deps())).toEqual({
			outcome: 'send_failed',
			channels: { ntfy: 'sent', fake: 'send_failed' }
		});
		expect(await deliveries()).toEqual([{ watchId: 'w1', kind: 'ntfy', targetPence: 2000 }]);
		expect(logs).toEqual(['[alerts] alert for watch w1 (fake) not delivered: refused']);

		// Still at target: only the channel that failed is tried again.
		expect(await alertAfterSuccess(h.db, 'w1', deps())).toEqual({
			outcome: 'sent',
			channels: { ntfy: 'already_sent', fake: 'sent' }
		});
		expect(ntfySend).toHaveBeenCalledOnce();
		expect(fake).toHaveBeenCalledTimes(2);
		expect(await deliveries()).toEqual([
			{ watchId: 'w1', kind: 'fake', targetPence: 2000 },
			{ watchId: 'w1', kind: 'ntfy', targetPence: 2000 }
		]);

		// Both have it now.
		expect((await alertAfterSuccess(h.db, 'w1', deps())).outcome).toBe('already_sent');
		expect(ntfySend).toHaveBeenCalledOnce();
		expect(fake).toHaveBeenCalledTimes(2);
	});

	it('stale retry dropped', async () => {
		const fake = fakeKind('fake');
		await saveNtfy();
		await saveFake('fake');
		await addWatch('w1');
		await addWatch('w2');
		expect((await alertAfterSuccess(h.db, 'w2', deps())).outcome).toBe('sent');

		// w1: ntfy delivered, fake pending a retry.
		fake.mockResolvedValueOnce({ ok: false, reason: 'unreachable' });
		await alertAfterSuccess(h.db, 'w1', deps());
		expect(await deliveries('w1')).toEqual([{ watchId: 'w1', kind: 'ntfy', targetPence: 2000 }]);
		ntfySend.mockClear();
		fake.mockClear();

		// The price rises above target: the pending retry is dropped, not sent.
		await setPrice('w1', 2100);
		expect(await alertAfterSuccess(h.db, 'w1', deps())).toEqual({
			outcome: 'rearmed',
			channels: {}
		});
		expect(ntfySend).not.toHaveBeenCalled();
		expect(fake).not.toHaveBeenCalled();
		expect(await deliveries('w1')).toEqual([]);
		// Another watch's deliveries are its own.
		expect(await deliveries('w2')).toEqual([
			{ watchId: 'w2', kind: 'fake', targetPence: 2000 },
			{ watchId: 'w2', kind: 'ntfy', targetPence: 2000 }
		]);
		expect(await alertAfterSuccess(h.db, 'w1', deps())).toEqual({
			outcome: 'not_due',
			channels: {}
		});

		// The next drop alerts every channel afresh.
		await setPrice('w1', 1500);
		expect(await alertAfterSuccess(h.db, 'w1', deps())).toEqual({
			outcome: 'sent',
			channels: { ntfy: 'sent', fake: 'sent' }
		});
		expect(ntfySend).toHaveBeenCalledOnce();
		expect(fake).toHaveBeenCalledOnce();
	});

	it('re-enable', async () => {
		const fake = fakeKind('fake');
		await saveNtfy();
		await saveFake('fake');
		await setEnabled(h.db, 'fake', false);
		await addWatch('w1');

		expect(await alertAfterSuccess(h.db, 'w1', deps())).toEqual({
			outcome: 'sent',
			channels: { ntfy: 'sent' }
		});
		expect(fake).not.toHaveBeenCalled();

		// Turned back on while the price is still at target: it gets the drop once.
		await setEnabled(h.db, 'fake', true);
		expect(await alertAfterSuccess(h.db, 'w1', deps())).toEqual({
			outcome: 'sent',
			channels: { ntfy: 'already_sent', fake: 'sent' }
		});
		expect(fake).toHaveBeenCalledOnce();
		expect(ntfySend).toHaveBeenCalledOnce();

		expect((await alertAfterSuccess(h.db, 'w1', deps())).outcome).toBe('already_sent');
		expect(fake).toHaveBeenCalledOnce();
	});

	it('target race', async () => {
		await saveNtfy();
		await addWatch('w1');
		const release = hold(ntfySend);

		const first = alertAfterSuccess(h.db, 'w1', deps());
		await vi.waitFor(() => expect(ntfySend).toHaveBeenCalledOnce());
		expect(await setTarget(h.db, 'w1', '25.00')).toMatchObject({ kind: 'updated' });
		release();

		// Delivered, but for a target that no longer stands: no row for it.
		expect(await first).toEqual({ outcome: 'sent', channels: { ntfy: 'sent' } });
		expect(await deliveries()).toEqual([]);

		// So the new target alerts on the next check.
		expect(await alertAfterSuccess(h.db, 'w1', deps())).toEqual({
			outcome: 'sent',
			channels: { ntfy: 'sent' }
		});
		expect(ntfySend).toHaveBeenCalledTimes(2);
		expect(ntfySend.mock.calls[1][1].message).toBe(
			'Acme Kettle™ is now £19.99, at or below your £25.00 target.'
		);
		expect(await deliveries()).toEqual([{ watchId: 'w1', kind: 'ntfy', targetPence: 2500 }]);
	});

	it('channel removed mid-send', async () => {
		await saveNtfy();
		await addWatch('w1');
		const release = hold(ntfySend);

		const first = alertAfterSuccess(h.db, 'w1', deps());
		await vi.waitFor(() => expect(ntfySend).toHaveBeenCalledOnce());
		await removeChannel(h.db, 'ntfy');
		release();

		// Delivered, but the channel is gone, so there is nothing to record it against.
		await expect(first).resolves.toEqual({ outcome: 'sent', channels: { ntfy: 'sent' } });
		expect(await deliveries()).toEqual([]);
		expect(logs).toHaveLength(1);
		expect(logs[0]).toMatch(/^\[alerts\] delivery for watch w1 \(ntfy\) not recorded \(\w+\)$/);
	});

	it('stale row upsert', async () => {
		await saveNtfy();
		await addWatch('w1');
		// Delivered for an older target that was since changed.
		await h.db.insert(priceDropDelivery).values({ watchId: 'w1', kind: 'ntfy', targetPence: 1500 });

		expect(await alertAfterSuccess(h.db, 'w1', deps())).toEqual({
			outcome: 'sent',
			channels: { ntfy: 'sent' }
		});
		expect(ntfySend).toHaveBeenCalledOnce();
		expect(await h.db.select().from(priceDropDelivery)).toEqual([
			{ watchId: 'w1', kind: 'ntfy', targetPence: 2000, deliveredAt: NOW }
		]);

		expect(await alertAfterSuccess(h.db, 'w1', deps())).toEqual({
			outcome: 'already_sent',
			channels: { ntfy: 'already_sent' }
		});
		expect(ntfySend).toHaveBeenCalledOnce();
	});

	it('isolation', async () => {
		const fake = fakeKind('fake');
		await saveNtfy();
		await saveFake('fake');
		await addWatch('w1');

		// One channel's send throws: the other is still sent, and nothing rejects.
		ntfySend.mockRejectedValueOnce(new TypeError('fetch failed'));
		await expect(alertAfterSuccess(h.db, 'w1', deps())).resolves.toEqual({
			outcome: 'send_failed',
			channels: { ntfy: 'send_failed', fake: 'sent' }
		});
		expect(fake).toHaveBeenCalledOnce();
		expect(await deliveries()).toEqual([{ watchId: 'w1', kind: 'fake', targetPence: 2000 }]);
		expect(logs).toEqual(['[alerts] alert for watch w1 (ntfy) failed (TypeError)']);

		// One channel's settings cannot be read: the other is still sent.
		await addWatch('w2');
		await h.db
			.update(notifyChannel)
			.set({ configEnc: 'v1:garbage' })
			.where(eq(notifyChannel.kind, 'ntfy'));
		logs = [];
		expect(await alertAfterSuccess(h.db, 'w2', deps())).toEqual({
			outcome: 'sent',
			channels: { fake: 'sent' }
		});
		expect(fake).toHaveBeenCalledTimes(2);
		expect(ntfySend).toHaveBeenCalledOnce();
		expect(logs).toEqual(['[alerts] channel (ntfy) could not be decrypted']);
	});

	it('parallel', async () => {
		const fake = fakeKind('fake');
		await saveNtfy();
		await saveFake('fake');
		await addWatch('w1');
		// ntfy is routed first; its send hangs until released.
		const release = hold(ntfySend);

		const first = alertAfterSuccess(h.db, 'w1', deps());
		await vi.waitFor(() => expect(ntfySend).toHaveBeenCalledOnce());
		// The second send neither waits for the first nor for its result to be recorded.
		await vi.waitFor(async () => {
			expect(fake).toHaveBeenCalledOnce();
			expect(await deliveries()).toEqual([{ watchId: 'w1', kind: 'fake', targetPence: 2000 }]);
		});

		release();
		expect(await first).toEqual({ outcome: 'sent', channels: { ntfy: 'sent', fake: 'sent' } });
		expect(await deliveries()).toHaveLength(2);
	});

	it('in_progress', async () => {
		const fake = fakeKind('fake');
		await saveNtfy();
		await saveFake('fake');
		await addWatch('w1');
		const release = hold(ntfySend);

		const first = alertAfterSuccess(h.db, 'w1', deps());
		await vi.waitFor(() => expect(fake).toHaveBeenCalledOnce());
		expect(ntfySend).toHaveBeenCalledOnce();

		// The first send is still pending, so this resolving proves the loser did not wait.
		expect(await alertAfterSuccess(h.db, 'w1', deps())).toEqual({
			outcome: 'in_progress',
			channels: {}
		});
		// Nor does an overlapping check that saw a rise re-arm under the send.
		await setPrice('w1', 2500);
		expect((await alertAfterSuccess(h.db, 'w1', deps())).outcome).toBe('in_progress');
		expect(ntfySend).toHaveBeenCalledOnce();
		expect(fake).toHaveBeenCalledOnce();

		release();
		expect((await first).outcome).toBe('sent');
		expect(await deliveries()).toHaveLength(2);

		// The claim went with the call: the next one decides again (and re-arms).
		expect((await alertAfterSuccess(h.db, 'w1', deps())).outcome).toBe('rearmed');
	});

	it('claim is per watch', async () => {
		await saveNtfy();
		await addWatch('w1');
		await addWatch('w2');
		const release = hold(ntfySend);

		const first = alertAfterSuccess(h.db, 'w1', deps());
		await vi.waitFor(() => expect(ntfySend).toHaveBeenCalledOnce());
		expect((await alertAfterSuccess(h.db, 'w2', deps())).outcome).toBe('sent');

		release();
		expect((await first).outcome).toBe('sent');
		expect(ntfySend).toHaveBeenCalledTimes(2);
	});

	it('log hygiene', async () => {
		await saveNtfy();
		await addWatch('w1');
		const secret = new Error(`${TOPIC} ${TOKEN}`);

		ntfySend.mockRejectedValueOnce(secret);
		expect((await alertAfterSuccess(h.db, 'w1', deps())).outcome).toBe('send_failed');
		ntfySend.mockRejectedValueOnce(secret);
		expect((await alertAfterFailure(h.db, 'w1', blocked, deps())).outcome).toBe('send_failed');

		// A failure outside any one send (here the key) is caught and logged the same way.
		const keyFails: AlertDeps = {
			...deps(),
			key: () => {
				throw secret;
			}
		};
		expect(await alertAfterSuccess(h.db, 'w1', keyFails)).toEqual({
			outcome: 'error',
			channels: {}
		});
		expect(await alertAfterFailure(h.db, 'w1', blocked, keyFails)).toEqual({
			outcome: 'error',
			channels: {}
		});

		expect(logs).toEqual([
			'[alerts] alert for watch w1 (ntfy) failed (Error)',
			'[alerts] failure alert for watch w1 (ntfy) failed (Error)',
			'[alerts] alert for watch w1 failed (Error)',
			'[alerts] failure alert for watch w1 failed (Error)'
		]);
		for (const line of logs) {
			for (const leak of [TOPIC, 'alice-secret-topic', TOKEN, 'tk_']) {
				expect(line).not.toContain(leak);
			}
		}
	});

	it('errors', async () => {
		await saveNtfy();
		await addWatch('w1');

		// No key installed: the call resolves, sends nothing, and the claim is released.
		const noKey: AlertDeps = {
			...deps(),
			key: () => {
				throw new AlertsKeyError('ALERTS_ENCRYPTION_KEY has not been loaded');
			}
		};
		expect((await alertAfterSuccess(h.db, 'w1', noKey)).outcome).toBe('error');
		expect(ntfySend).not.toHaveBeenCalled();

		// A thrown non-Error is named generically.
		ntfySend.mockRejectedValueOnce('a plain string');
		expect((await alertAfterSuccess(h.db, 'w1', deps())).outcome).toBe('send_failed');
		expect(logs).toEqual([
			'[alerts] alert for watch w1 failed (AlertsKeyError)',
			'[alerts] alert for watch w1 (ntfy) failed (error)'
		]);
		expect(await alertAfterSuccess(h.db, 'w1', deps())).toEqual({
			outcome: 'sent',
			channels: { ntfy: 'sent' }
		});
	});

	it('default log', async () => {
		await saveNtfy();
		await addWatch('w1');
		ntfySend.mockResolvedValueOnce({ ok: false, reason: 'timeout' });
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

		await alertAfterSuccess(h.db, 'w1', { key: () => KEY, fetch });
		expect(consoleError).toHaveBeenCalledExactlyOnceWith(
			'[alerts] alert for watch w1 (ntfy) not delivered: timeout'
		);

		// Default clock on delivery.
		const before = Date.now();
		await alertAfterSuccess(h.db, 'w1', { key: () => KEY, fetch });
		const [row] = await h.db.select().from(priceDropDelivery);
		expect(row.deliveredAt.getTime()).toBeGreaterThanOrEqual(before);
	});

	it('ntfy and resend', async () => {
		// The real ntfy and resend drivers, over a fetch routed by host.
		ntfySend.mockRestore();
		const RESEND_KEY = 're_AliceResend_9fQ2xLm7Tz0kWv3'; // key-shaped, not a real one
		const resendAnswers: (() => Response)[] = [];
		const routed = vi.fn<AlertDeps['fetch']>(async (input) => {
			const host = new URL(input).host;
			if (host === 'ntfy.sh') return new Response('{}', { status: 200 });
			if (host === 'api.resend.com') {
				const answer = resendAnswers.shift();
				if (answer === undefined) throw new Error('unexpected resend send');
				return answer();
			}
			throw new Error(`unexpected host ${host}`);
		});
		const hostsOf = (calls: typeof routed.mock.calls) =>
			calls.map(([input, init]) => `${init.method} ${input}`);

		// Every console method is spied; with no log injected, alerts log to console.error.
		const lines: string[] = [];
		for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const) {
			vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
				lines.push(args.map(String).join(' '));
			});
		}
		const live: AlertDeps = { key: () => KEY, fetch: routed, now: () => NOW };

		await saveNtfy(DROPS);
		expect(
			await saveChannel(h.db, KEY, 'resend', {
				api_key: RESEND_KEY,
				from: 'alerts@alice-shop.test',
				to: 'alice@example.test'
			})
		).toEqual({ ok: true });
		await addWatch('w1');

		// One drop: one POST to each; Resend answers 500, so only ntfy is recorded.
		resendAnswers.push(
			() =>
				new Response(
					JSON.stringify({ statusCode: 500, name: 'application_error', message: RESEND_KEY }),
					{ status: 500, headers: { 'content-type': 'application/json' } }
				)
		);
		expect(await alertAfterSuccess(h.db, 'w1', live)).toEqual({
			outcome: 'send_failed',
			channels: { ntfy: 'sent', resend: 'send_failed' }
		});
		expect(hostsOf(routed.mock.calls).sort()).toEqual([
			'POST https://api.resend.com/emails',
			'POST https://ntfy.sh/'
		]);
		expect(await deliveries()).toEqual([{ watchId: 'w1', kind: 'ntfy', targetPence: 2000 }]);

		// The next check retries Resend only.
		routed.mockClear();
		resendAnswers.push(() => new Response('{"id":"e1"}', { status: 200 }));
		expect(await alertAfterSuccess(h.db, 'w1', live)).toEqual({
			outcome: 'sent',
			channels: { ntfy: 'already_sent', resend: 'sent' }
		});
		expect(hostsOf(routed.mock.calls)).toEqual(['POST https://api.resend.com/emails']);
		expect(await deliveries()).toEqual([
			{ watchId: 'w1', kind: 'ntfy', targetPence: 2000 },
			{ watchId: 'w1', kind: 'resend', targetPence: 2000 }
		]);

		// Both have it: a third check sends nothing.
		routed.mockClear();
		expect((await alertAfterSuccess(h.db, 'w1', live)).outcome).toBe('already_sent');
		expect(routed).not.toHaveBeenCalled();

		// Another drop whose Resend send throws an error carrying the key.
		await addWatch('w2');
		resendAnswers.push(() => {
			throw new Error(`request with Bearer ${RESEND_KEY} failed`);
		});
		expect(await alertAfterSuccess(h.db, 'w2', live)).toEqual({
			outcome: 'send_failed',
			channels: { ntfy: 'sent', resend: 'send_failed' }
		});
		expect(resendAnswers).toEqual([]);

		// resend log hygiene: fixed lines only, never the key.
		expect(lines).toEqual([
			'[alerts] alert for watch w1 (resend) not delivered: refused',
			'[alerts] alert for watch w2 (resend) not delivered: unreachable'
		]);
		for (const line of lines) {
			for (const leak of [RESEND_KEY, 'AliceResend_9fQ2xLm7Tz0kWv3']) {
				expect(line).not.toContain(leak);
			}
		}
	});

	it('ntfy, resend and smtp', async () => {
		// The real ntfy and resend drivers over a fetch routed by host; the real SMTP
		// driver against the fake server.
		ntfySend.mockRestore();
		const RESEND_KEY = 're_AliceResend_9fQ2xLm7Tz0kWv3'; // key-shaped, not a real one
		const SMTP_PASSWORD = 'qzpx vtrw mkdl hsye'; // app-password-shaped, not a real one
		const smtp = await realSmtp();
		const routed = vi.fn<AlertDeps['fetch']>(async (input) => {
			const host = new URL(input).host;
			if (host === 'ntfy.sh') return new Response('{}', { status: 200 });
			if (host === 'api.resend.com') return new Response('{"id":"e1"}', { status: 200 });
			throw new Error(`unexpected host ${host}`);
		});
		const hostsOf = (calls: typeof routed.mock.calls) =>
			calls.map(([input, init]) => `${init.method} ${input}`).sort();
		const BOTH_POSTS = ['POST https://api.resend.com/emails', 'POST https://ntfy.sh/'];

		// Every console method is spied; with no log injected, alerts log to console.error.
		const lines: string[] = [];
		for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const) {
			vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
				lines.push(args.map(String).join(' '));
			});
		}
		const live: AlertDeps = { key: () => KEY, fetch: routed, now: () => NOW };

		await saveNtfy(DROPS);
		expect(
			await saveChannel(h.db, KEY, 'resend', {
				api_key: RESEND_KEY,
				from: 'alerts@alice-shop.test',
				to: 'alice@example.test'
			})
		).toEqual({ ok: true });
		// Saved without routing: a new SMTP channel gets price drops.
		expect(
			await saveChannel(h.db, KEY, 'smtp', {
				host: smtp.host,
				port: String(smtp.port),
				username: 'alice@alice-mail.test',
				password: SMTP_PASSWORD,
				from: 'alerts@alice-shop.test',
				to: 'alice@example.test'
			})
		).toEqual({ ok: true });

		// One drop: one POST to ntfy, one to Resend, one message at the SMTP server.
		await addWatch('w1');
		expect(await alertAfterSuccess(h.db, 'w1', live)).toEqual({
			outcome: 'sent',
			channels: { ntfy: 'sent', resend: 'sent', smtp: 'sent' }
		});
		expect(hostsOf(routed.mock.calls)).toEqual(BOTH_POSTS);
		expect(smtp.messages).toHaveLength(1);
		expect(smtp.messages[0]).toMatchObject({
			from: 'alerts@alice-shop.test',
			to: ['alice@example.test'],
			auth: { username: 'alice@alice-mail.test', password: SMTP_PASSWORD },
			secure: true
		});
		expect(await deliveries('w1')).toEqual([
			{ watchId: 'w1', kind: 'ntfy', targetPence: 2000 },
			{ watchId: 'w1', kind: 'resend', targetPence: 2000 },
			{ watchId: 'w1', kind: 'smtp', targetPence: 2000 }
		]);

		// Another drop while the SMTP server refuses the recipient (550): ntfy and
		// Resend get it, SMTP does not, so only those two are recorded.
		await addWatch('w2');
		routed.mockClear();
		smtp.setMode('rcpt_reject');
		expect(await alertAfterSuccess(h.db, 'w2', live)).toEqual({
			outcome: 'send_failed',
			channels: { ntfy: 'sent', resend: 'sent', smtp: 'send_failed' }
		});
		expect(hostsOf(routed.mock.calls)).toEqual(BOTH_POSTS);
		expect(smtp.messages).toHaveLength(1);
		expect(await deliveries('w2')).toEqual([
			{ watchId: 'w2', kind: 'ntfy', targetPence: 2000 },
			{ watchId: 'w2', kind: 'resend', targetPence: 2000 }
		]);

		// The server takes mail again: the next check retries SMTP only.
		routed.mockClear();
		smtp.setMode('ok');
		expect(await alertAfterSuccess(h.db, 'w2', live)).toEqual({
			outcome: 'sent',
			channels: { ntfy: 'already_sent', resend: 'already_sent', smtp: 'sent' }
		});
		expect(routed).not.toHaveBeenCalled();
		expect(smtp.messages).toHaveLength(2);
		expect(smtp.messages[1].to).toEqual(['alice@example.test']);
		expect(await deliveries('w2')).toEqual([
			{ watchId: 'w2', kind: 'ntfy', targetPence: 2000 },
			{ watchId: 'w2', kind: 'resend', targetPence: 2000 },
			{ watchId: 'w2', kind: 'smtp', targetPence: 2000 }
		]);

		// All three have it: a third check sends nothing anywhere.
		expect(await alertAfterSuccess(h.db, 'w2', live)).toEqual({
			outcome: 'already_sent',
			channels: { ntfy: 'already_sent', resend: 'already_sent', smtp: 'already_sent' }
		});
		expect(routed).not.toHaveBeenCalled();
		expect(smtp.messages).toHaveLength(2);

		// A third drop whose login is rejected with a 535 that echoes the password.
		await addWatch('w3');
		const authsBefore = smtp.auths.length;
		smtp.setMode('auth_reject', {
			authRejectText: `5.7.8 Username and Password not accepted: ${SMTP_PASSWORD}`
		});
		expect((await alertAfterSuccess(h.db, 'w3', live)).channels).toEqual({
			ntfy: 'sent',
			resend: 'sent',
			smtp: 'send_failed'
		});
		expect(smtp.auths.length).toBe(authsBefore + 1);
		expect(smtp.messages).toHaveLength(2);

		// smtp log hygiene: fixed lines only, never the password.
		expect(lines).toEqual([
			'[alerts] alert for watch w2 (smtp) not delivered: refused',
			'[alerts] alert for watch w3 (smtp) not delivered: bad credentials'
		]);
		for (const line of lines) {
			for (const leak of [SMTP_PASSWORD, 'qzpx', 'vtrw mkdl', 'hsye']) {
				expect(line).not.toContain(leak);
			}
		}
	});

	it('nothing to send', async () => {
		const fake = fakeKind('fake');

		// No channel at all, or only a failures-only one.
		await addWatch('w1');
		expect(await alertAfterSuccess(h.db, 'w1', deps())).toEqual({
			outcome: 'no_channel',
			channels: {}
		});
		await saveFake('fake', FAILURES);
		expect((await alertAfterSuccess(h.db, 'w1', deps())).outcome).toBe('no_channel');

		await saveNtfy(DROPS);
		// No target, or no price yet.
		await addWatch('w2', { targetPence: null });
		await addWatch('w3', { pricePence: null });
		expect((await alertAfterSuccess(h.db, 'w2', deps())).outcome).toBe('not_due');
		expect((await alertAfterSuccess(h.db, 'w3', deps())).outcome).toBe('not_due');
		// Above target.
		await addWatch('w4', { pricePence: 2001 });
		expect((await alertAfterSuccess(h.db, 'w4', deps())).outcome).toBe('not_due');
		// Missing watch.
		expect(await alertAfterSuccess(h.db, 'missing', deps())).toEqual({
			outcome: 'not_found',
			channels: {}
		});

		expect(ntfySend).not.toHaveBeenCalled();
		expect(fake).not.toHaveBeenCalled();
		expect(await deliveries()).toEqual([]);
	});
});

describe('alertAfterFailure', () => {
	it('failure routing', async () => {
		const dropsOnly = fakeKind('drops-only');
		const failuresOnly = fakeKind('failures-only');
		const disabled = fakeKind('disabled');
		await saveNtfy();
		await saveFake('drops-only', DROPS);
		await saveFake('failures-only', FAILURES);
		await saveFake('disabled', FAILURES);
		await setEnabled(h.db, 'disabled', false);
		await addWatch('w1');
		failuresOnly.mockResolvedValueOnce({ ok: false, reason: 'bad_credentials', status: 403 });

		expect(await alertAfterFailure(h.db, 'w1', blocked, deps())).toEqual({
			outcome: 'send_failed',
			channels: { ntfy: 'sent', 'failures-only': 'send_failed' }
		});
		expect(sentKinds(ntfySend)).toEqual(['check_failed']);
		expect(sentKinds(failuresOnly)).toEqual(['check_failed']);
		expect(dropsOnly).not.toHaveBeenCalled();
		expect(disabled).not.toHaveBeenCalled();
		expect(await deliveries()).toEqual([]);
		expect(logs).toEqual([
			'[alerts] failure alert for watch w1 (failures-only) not delivered: bad credentials'
		]);

		// The next check succeeds at target: the failed failure alert is not retried.
		expect((await alertAfterSuccess(h.db, 'w1', deps())).channels).toEqual({
			ntfy: 'sent',
			'drops-only': 'sent'
		});
		expect(sentKinds(ntfySend)).toEqual(['check_failed', 'price_drop']);
		expect(sentKinds(failuresOnly)).toEqual(['check_failed']);
		expect(disabled).not.toHaveBeenCalled();

		// Each failed check alerts again (decision failure_alerts_no_retry).
		expect(await alertAfterFailure(h.db, 'w1', blocked, deps())).toEqual({
			outcome: 'sent',
			channels: { ntfy: 'sent', 'failures-only': 'sent' }
		});
		expect(sentKinds(ntfySend)).toEqual(['check_failed', 'price_drop', 'check_failed']);
		expect(sentKinds(failuresOnly)).toEqual(['check_failed', 'check_failed']);
		expect(dropsOnly).toHaveBeenCalledOnce();
		expect(disabled).not.toHaveBeenCalled();
		// The price-drop delivery rows are untouched by failure alerts.
		expect(await deliveries()).toEqual([
			{ watchId: 'w1', kind: 'drops-only', targetPence: 2000 },
			{ watchId: 'w1', kind: 'ntfy', targetPence: 2000 }
		]);
	});

	it('alert', async () => {
		await saveNtfy();
		await addWatch('w1');
		await addWatch('w2', { title: null });

		expect((await alertAfterFailure(h.db, 'w1', blocked, deps())).outcome).toBe('sent');
		expect(ntfySend).toHaveBeenCalledExactlyOnceWith(
			{ url: TOPIC, token: TOKEN },
			{
				kind: 'check_failed',
				title: 'Check failed: Acme Kettle™',
				message: "Couldn't check Acme Kettle™: Amazon served a robot-check (captcha) page.",
				click: 'https://www.amazon.co.uk/dp/w1'
			},
			{ fetch }
		);

		// An untitled watch is named by its URL.
		await alertAfterFailure(h.db, 'w2', blocked, deps());
		expect(ntfySend.mock.calls[1][1].title).toBe('Check failed: https://www.amazon.co.uk/dp/w2');
	});

	it('parallel', async () => {
		const fake = fakeKind('fake');
		await saveNtfy();
		await saveFake('fake');
		await addWatch('w1');
		const release = hold(ntfySend);

		const first = alertAfterFailure(h.db, 'w1', blocked, deps());
		await vi.waitFor(() => expect(fake).toHaveBeenCalledOnce());
		release();
		expect(await first).toEqual({ outcome: 'sent', channels: { ntfy: 'sent', fake: 'sent' } });
	});

	it('undecryptable channel', async () => {
		const fake = fakeKind('fake');
		await saveFake('fake', FAILURES);
		// Sealed under another key: this install's key cannot open it.
		const saved = await saveChannel(
			h.db,
			randomBytes(32),
			'ntfy',
			{ topic: TOPIC, token: TOKEN },
			FAILURES
		);
		expect(saved).toEqual({ ok: true });
		await addWatch('w1');

		// The other channel is still told, and the unreadable one is logged through deps.log.
		expect(await alertAfterFailure(h.db, 'w1', blocked, deps())).toEqual({
			outcome: 'sent',
			channels: { fake: 'sent' }
		});
		expect(sentKinds(fake)).toEqual(['check_failed']);
		expect(ntfySend).not.toHaveBeenCalled();
		expect(logs).toEqual(['[alerts] channel (ntfy) could not be decrypted']);
	});

	it('nothing to send', async () => {
		await addWatch('w1');
		// No channel at all, then only a drops-only one.
		expect(await alertAfterFailure(h.db, 'w1', blocked, deps())).toEqual({
			outcome: 'no_channel',
			channels: {}
		});
		await saveNtfy(DROPS);
		expect((await alertAfterFailure(h.db, 'w1', blocked, deps())).outcome).toBe('no_channel');
		expect(await alertAfterFailure(h.db, 'gone', blocked, deps())).toEqual({
			outcome: 'not_found',
			channels: {}
		});
		expect(ntfySend).not.toHaveBeenCalled();
	});
});
