import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { eq } from 'drizzle-orm';
import { notifyChannel, priceDropDelivery, watch } from '../db/schema.ts';
import type { DesktopNotice, DesktopNotifier } from '../notify-bridge.ts';
import { failure } from '../shops/types.ts';
import { createTestDb, type TestDb } from '../testing/test-db.ts';
import { deleteWatch, getWatch, setTarget } from '../watches.ts';
import { alertAfterFailure, alertAfterSuccess, type AlertDeps } from './alerts.ts';
import type { Alert } from './channel.ts';
import {
	UNKNOWN_KIND_MESSAGE,
	channelKinds,
	listChannels,
	saveChannel,
	setEnabled
} from './channels.ts';
import { createDesktopDriver, installDesktop, type DesktopDeps } from './desktop.ts';

// The notifier is a fake: nothing here touches Electron or the OS. Where ntfy is
// saved too it runs the real driver over a fetch stub against a .invalid host, so
// nothing reaches a real server (r-01).

const KEY = randomBytes(32);
const TOPIC = 'https://ntfy.invalid/desktop-spec-topic';
const NOW = new Date('2026-11-14T12:00:00Z');

type Show = DesktopNotifier['show'];

let h: TestDb;
let logs: string[];
let fetch: Mock<AlertDeps['fetch']>;
let show: Mock<Show>;
let notifier: DesktopNotifier;
let unregister: (() => void)[] = [];

const watchExists: DesktopDeps['watchExists'] = async (id) => (await getWatch(h.db, id)) !== null;

beforeEach(async () => {
	h = await createTestDb();
	logs = [];
	fetch = vi.fn<AlertDeps['fetch']>(async () => new Response('{}', { status: 200 }));
	show = vi.fn<Show>(async () => ({ ok: true }));
	notifier = { show };
});
afterEach(() => {
	for (const undo of unregister.reverse()) undo();
	unregister = [];
	h.dispose();
	// No cross-spec leak: every install here is undone.
	expect(channelKinds()).not.toContain('desktop');
});

async function install(): Promise<void> {
	unregister.push(await installDesktop(h.db, KEY, notifier, { watchExists }));
}

async function saveNtfy(): Promise<void> {
	const saved = await saveChannel(
		h.db,
		KEY,
		'ntfy',
		{ topic: TOPIC },
		{ priceDrops: true, checkFailures: false }
	);
	expect(saved).toEqual({ ok: true });
}

async function addWatch(id: string, fields: Partial<typeof watch.$inferInsert> = {}) {
	await h.db.insert(watch).values({
		id,
		shop: 'amazon-uk',
		productId: `B0${id.replace(/[^A-Za-z0-9]/g, '')}`.padEnd(10, '0'),
		canonicalUrl: `https://www.amazon.co.uk/dp/${encodeURIComponent(id)}`,
		title: 'Acme Kettle™',
		pricePence: 900,
		targetPence: 1000,
		...fields
	});
}

const setPrice = (id: string, pricePence: number) =>
	h.db.update(watch).set({ pricePence }).where(eq(watch.id, id));

const check = (id = 'w1') => alertAfterSuccess(h.db, id, deps());

function deps(): AlertDeps {
	return { key: () => KEY, fetch, now: () => NOW, log: (message) => logs.push(message) };
}

/** Delivery rows' channel kinds for a watch, sorted. */
async function deliveredKinds(watchId = 'w1'): Promise<string[]> {
	const rows = await h.db
		.select()
		.from(priceDropDelivery)
		.where(eq(priceDropDelivery.watchId, watchId));
	return rows.map((row) => row.kind).sort();
}

/** The notice passed to the nth show. */
const notice = (n = 0): DesktopNotice => show.mock.calls[n][0];

describe('price drop to desktop', () => {
	it('drop shows once', async () => {
		await install();
		await addWatch('w1');

		expect(await check()).toEqual({ outcome: 'sent', channels: { desktop: 'sent' } });
		expect(show).toHaveBeenCalledOnce();
		expect(notice().title).toContain('Acme Kettle™');
		expect(notice().body).toContain('£9.00');
		expect(notice().body).toContain('£10.00');
		expect(fetch).not.toHaveBeenCalled();
	});

	it('ntfy too', async () => {
		await saveNtfy();
		await install();
		await addWatch('w1');

		expect(await check()).toEqual({
			outcome: 'sent',
			channels: { ntfy: 'sent', desktop: 'sent' }
		});
		expect(fetch).toHaveBeenCalledOnce();
		expect(show).toHaveBeenCalledOnce();
	});

	it('desktop failure isolated', async () => {
		await saveNtfy();
		await install();
		await addWatch('w1');
		show.mockResolvedValueOnce({ ok: false, reason: 'failed' });

		expect(await check()).toEqual({
			outcome: 'send_failed',
			channels: { ntfy: 'sent', desktop: 'send_failed' }
		});
		expect(fetch).toHaveBeenCalledOnce();
		expect(await deliveredKinds()).toEqual(['ntfy']);

		// The next check retries only the desktop.
		expect(await check()).toEqual({
			outcome: 'sent',
			channels: { ntfy: 'already_sent', desktop: 'sent' }
		});
		expect(fetch).toHaveBeenCalledOnce();
		expect(show).toHaveBeenCalledTimes(2);
		expect(await deliveredKinds()).toEqual(['desktop', 'ntfy']);
	});

	it('once per target', async () => {
		await install();
		await addWatch('w1');
		expect((await check()).outcome).toBe('sent');

		expect(await check()).toEqual({
			outcome: 'already_sent',
			channels: { desktop: 'already_sent' }
		});
		await setPrice('w1', 850);
		expect(await check()).toEqual({
			outcome: 'already_sent',
			channels: { desktop: 'already_sent' }
		});
		expect(show).toHaveBeenCalledOnce();
	});

	it('re-arm', async () => {
		await install();
		await addWatch('w1');
		expect((await check()).outcome).toBe('sent');

		// Above target re-arms; the next drop shows again.
		await setPrice('w1', 1100);
		expect((await check()).outcome).toBe('rearmed');
		await setPrice('w1', 900);
		expect((await check()).channels).toEqual({ desktop: 'sent' });
		expect(show).toHaveBeenCalledTimes(2);

		// A changed target re-arms too.
		expect(await setTarget(h.db, 'w1', '9.50')).toEqual({ kind: 'updated', targetPence: 950 });
		expect((await check()).channels).toEqual({ desktop: 'sent' });
		expect(show).toHaveBeenCalledTimes(3);
		expect(notice(2).body).toContain('£9.50');
	});
});

describe('delivery_result', () => {
	for (const reason of ['unsupported', 'failed'] as const) {
		it(`retried after ${reason}`, async () => {
			await install();
			await addWatch('w1');
			show.mockResolvedValueOnce({ ok: false, reason });

			expect(await check()).toEqual({
				outcome: 'send_failed',
				channels: { desktop: 'send_failed' }
			});
			expect(await deliveredKinds()).toEqual([]);

			expect(await check()).toEqual({ outcome: 'sent', channels: { desktop: 'sent' } });
			expect(show).toHaveBeenCalledTimes(2);
		});
	}

	it('no flood', async () => {
		await install();
		await addWatch('w1');

		expect((await check()).outcome).toBe('sent');
		expect(await deliveredKinds()).toEqual(['desktop']);
		expect((await check()).outcome).toBe('already_sent');
		expect(show).toHaveBeenCalledOnce();
	});

	// A notifier whose isSupported() or on() throws must not escape the driver: the
	// send fails with a fixed reason, is logged without the error's text, and retried.
	const throwers: [string, () => Show][] = [
		[
			'throwing notifier',
			() => () => {
				throw new Error('boom at https://ntfy.invalid/secret-topic');
			}
		],
		[
			'rejecting notifier',
			() => async () => {
				throw new Error('boom at https://ntfy.invalid/secret-topic');
			}
		]
	];
	for (const [name, make] of throwers) {
		it(`${name} is a failed send`, async () => {
			await install();
			await addWatch('w1');
			show.mockImplementationOnce(make());

			expect(await check()).toEqual({
				outcome: 'send_failed',
				channels: { desktop: 'send_failed' }
			});
			expect(logs).toEqual(['[alerts] alert for watch w1 (desktop) not delivered: unreachable']);
			expect(logs.join('\n')).not.toContain('secret-topic');
			expect(await deliveredKinds()).toEqual([]);

			expect(await check()).toEqual({ outcome: 'sent', channels: { desktop: 'sent' } });
		});
	}
});

describe('send', () => {
	const ALERT: Alert = { kind: 'price_drop', title: 'T — £1', message: 'M ™', watchId: 'w1' };
	const send = (alert: Alert = ALERT) =>
		createDesktopDriver(notifier, { watchExists }).send({}, alert, { fetch });

	it('results', async () => {
		expect(await send()).toEqual({ ok: true });
		expect(notice().title).toBe('T — £1');
		expect(notice().body).toBe('M ™');

		show.mockResolvedValueOnce({ ok: false, reason: 'unsupported' });
		expect(await send()).toEqual({ ok: false, reason: 'unsupported' });
		show.mockResolvedValueOnce({ ok: false, reason: 'failed' });
		expect(await send()).toEqual({ ok: false, reason: 'refused' });

		show.mockImplementationOnce(() => {
			throw new Error('isSupported threw');
		});
		await expect(send()).resolves.toEqual({ ok: false, reason: 'unreachable' });
		show.mockRejectedValueOnce(new Error('on threw'));
		await expect(send()).resolves.toEqual({ ok: false, reason: 'unreachable' });
		expect(fetch).not.toHaveBeenCalled();
	});

	it('driver shape', () => {
		const driver = createDesktopDriver(notifier, { watchExists });
		expect(driver.kind).toBe('desktop');
		expect(driver.defaultKinds).toEqual(['price_drop']);
		expect(driver.parseConfig({ anything: 'typed' }, null)).toEqual({ ok: true, config: {} });
		expect(driver.view({})).toEqual({});
	});

	it('click path', async () => {
		await addWatch('a/b?c');
		await send({ ...ALERT, watchId: 'a/b?c' });
		expect(await notice().clickPath()).toBe('/watches/a%2Fb%3Fc');

		// Resolved at click time: once the watch is gone, the watchlist.
		expect(await deleteWatch(h.db, 'a/b?c')).toBe(true);
		expect(await notice().clickPath()).toBe('/');

		await send({ kind: 'test', title: 't', message: 'm' });
		expect(await notice(1).clickPath()).toBe('/account/alerts');

		// A lookup that fails opens the watchlist rather than rejecting.
		const broken = createDesktopDriver(notifier, {
			watchExists: async () => {
				throw new Error('db gone');
			}
		});
		await broken.send({}, ALERT, { fetch });
		expect(await notice(2).clickPath()).toBe('/');
	});

	it('failure alert click', async () => {
		await install();
		await addWatch('w1');
		expect(
			await saveChannel(h.db, KEY, 'desktop', {}, { priceDrops: true, checkFailures: true })
		).toEqual({ ok: true });

		const report = await alertAfterFailure(h.db, 'w1', failure('blocked', 'robot check'), deps());
		expect(report).toEqual({ outcome: 'sent', channels: { desktop: 'sent' } });
		expect(await notice().clickPath()).toBe('/watches/w1');
	});
});

describe('channel row', () => {
	it('failed checks off by default', async () => {
		await install();
		await addWatch('w1');

		const report = await alertAfterFailure(h.db, 'w1', failure('blocked', 'robot check'), deps());
		expect(report).toEqual({ outcome: 'no_channel', channels: {} });
		expect(show).not.toHaveBeenCalled();
	});

	it('disabled stays silent', async () => {
		await install();
		await addWatch('w1');
		expect(await setEnabled(h.db, 'desktop', false)).toBe(true);

		expect(await check()).toEqual({ outcome: 'no_channel', channels: {} });
		expect(show).not.toHaveBeenCalled();
	});

	it('seed', async () => {
		await install();
		expect(await listChannels(h.db, KEY)).toEqual({
			desktop: {
				enabled: true,
				priceDrops: true,
				checkFailures: false,
				unreadable: false,
				view: {}
			}
		});
	});

	it('seed never overwrites', async () => {
		await install();
		await h.db
			.update(notifyChannel)
			.set({ enabled: false, priceDrops: false, checkFailures: true })
			.where(eq(notifyChannel.kind, 'desktop'));

		// A relaunch installs again.
		unregister.pop()!();
		await install();
		await install();

		const rows = await h.db.select().from(notifyChannel);
		expect(
			rows.map(({ kind, enabled, priceDrops, checkFailures }) => ({
				kind,
				enabled,
				priceDrops,
				checkFailures
			}))
		).toEqual([{ kind: 'desktop', enabled: false, priceDrops: false, checkFailures: true }]);
	});
});

describe('registration', () => {
	it('desktop only when installed', async () => {
		expect(channelKinds()).not.toContain('desktop');
		expect(await saveChannel(h.db, KEY, 'desktop', {})).toEqual({
			ok: false,
			message: UNKNOWN_KIND_MESSAGE
		});

		const undo = await installDesktop(h.db, KEY, notifier, { watchExists });
		expect(channelKinds()).toContain('desktop');
		undo();
		expect(channelKinds()).not.toContain('desktop');
	});

	it('failed seed unregisters', async () => {
		h.db.$client.close();
		await expect(installDesktop(h.db, KEY, notifier, { watchExists })).rejects.toThrow();
		expect(channelKinds()).not.toContain('desktop');
	});
});
