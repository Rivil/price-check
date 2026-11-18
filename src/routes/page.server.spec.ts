import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { isActionFailure } from '@sveltejs/kit';
import { saveChannel } from '#lib/server/alerts/channels.ts';
import { setAlertsKey } from '#lib/server/alerts/crypto.ts';
import { dueWatches } from '#lib/server/checks.ts';
import { pricePoint, watch } from '#lib/server/db/schema.ts';
import { failure, type CheckResult } from '#lib/server/shops/types.ts';
import { createTestDb, type TestDb } from '#lib/server/testing/test-db.ts';

// The route's db is a fresh migrated temp SQLite; its shop keeps the real offline
// identify but checkUrl is a stub, so nothing here can reach amazon.co.uk (r-01).
const state = vi.hoisted(() => ({
	h: null as TestDb | null,
	checkUrl: null as unknown as Mock<(url: string) => Promise<CheckResult>>,
	intervalHours: undefined as string | undefined
}));
vi.mock('$app/env/private', () => ({
	get CHECK_INTERVAL_HOURS() {
		return state.intervalHours;
	}
}));
vi.mock('#lib/server/db/index.ts', () => ({
	get db() {
		return state.h!.db;
	}
}));
vi.mock('#lib/server/shops/index.ts', async (importOriginal) => ({
	...(await importOriginal<object>()),
	checkUrl: (url: string) => state.checkUrl(url)
}));

const { load, actions } = await import('./+page.server.ts');

type Event = Parameters<typeof load>[0];
type Card = {
	id: string;
	label: string;
	status: { nextDueAt: Date | null };
	sparkline: { path: string } | null;
	sparklineLabel: string | null;
};

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const CHECKED_AT = new Date('2026-11-01T09:30:00Z');

/** No signed-in user anywhere: the install's data is everyone's who can reach it. */
function event(form?: Record<string, string>): Event {
	const body = new URLSearchParams(form ?? {});
	return {
		locals: {},
		request: new Request('http://localhost/?/add', { method: 'POST', body })
	} as unknown as Event;
}

async function cards() {
	return ((await load(event())) as { watches: Card[] }).watches;
}

async function card(id: string) {
	const found = (await cards()).find((c) => c.id === id);
	if (found === undefined) throw new Error(`no card ${id}`);
	return found;
}

function addPoints(watchId: string, points: [daysAgo: number, pricePence: number][]) {
	return state.h!.db.insert(pricePoint).values(
		points.map(([daysAgo, pricePence]) => ({
			id: `${watchId}-${daysAgo}`,
			watchId,
			pricePence,
			checkedAt: new Date(Date.now() - daysAgo * DAY)
		}))
	);
}

/** Two watches, w1 and w2, both last checked at CHECKED_AT. */
async function seed() {
	const row = (id: string, productId: string, title: string) => ({
		id,
		shop: 'amazon-uk',
		productId,
		canonicalUrl: `https://www.amazon.co.uk/dp/${productId}`,
		title,
		pricePence: 129900,
		lastCheckedAt: CHECKED_AT
	});
	await state
		.h!.db.insert(watch)
		.values([row('w1', 'B0KETTLE01', 'Kettle'), row('w2', 'B0TOASTER1', 'Toaster')]);
}

beforeEach(async () => {
	state.h = await createTestDb();
	state.checkUrl = vi.fn<(url: string) => Promise<CheckResult>>();
	state.intervalHours = undefined;
});
afterEach(() => state.h!.dispose());

describe('load', () => {
	it('fresh install', async () => {
		// No login, no redirect, no account: the empty watchlist straight away.
		await expect(load(event())).resolves.toEqual({ watches: [] });
	});

	it('load', async () => {
		await seed();
		const data = (await load(event())) as {
			watches: { id: string; label: string; price: string }[];
		};
		expect(
			data.watches
				.map(({ id, label, price }) => ({ id, label, price }))
				.sort((a, b) => a.id.localeCompare(b.id))
		).toEqual([
			{ id: 'w1', label: 'Kettle', price: '£1,299.00' },
			{ id: 'w2', label: 'Toaster', price: '£1,299.00' }
		]);
	});

	it('carries no nav data (the layout owns the header)', async () => {
		const data = (await load(event())) as Record<string, unknown>;
		expect(Object.keys(data)).toStrictEqual(['watches']);
	});

	it('status interval', async () => {
		await seed();
		state.intervalHours = '12';
		expect((await card('w1')).status.nextDueAt).toEqual(new Date(CHECKED_AT.getTime() + 12 * HOUR));

		state.intervalHours = undefined;
		expect((await card('w1')).status.nextDueAt).toEqual(new Date(CHECKED_AT.getTime() + 6 * HOUR));
	});

	it('matches scheduler', async () => {
		await seed();
		const nextDueAt = (await card('w1')).status.nextDueAt as Date;
		const dueAt = async (at: Date) =>
			(await dueWatches(state.h!.db, at, 6 * HOUR)).map((due) => due.id);

		expect(await dueAt(nextDueAt)).toContain('w1');
		expect(await dueAt(new Date(nextDueAt.getTime() - 1))).not.toContain('w1');
	});

	it('sparkline per watch', async () => {
		await seed();
		await addPoints('w1', [
			[40, 9900],
			[20, 2000],
			[10, 1800]
		]);
		await addPoints('w2', [[5, 100]]);

		const kettle = await card('w1');
		expect(kettle.sparkline?.path.match(/[ML]/g)).toHaveLength(2);
		expect(kettle.sparklineLabel).toBe('30-day prices, lowest £18.00, highest £20.00');
		expect((await card('w2')).sparkline?.path.match(/[ML]/g)).toHaveLength(1);
	});

	it('no sparkline without recent prices', async () => {
		await seed();
		await addPoints('w1', [[40, 9900]]);

		expect(await card('w1')).toEqual(
			expect.objectContaining({ sparkline: null, sparklineLabel: null })
		);
	});
});

describe('actions.add', () => {
	it('add refusals', async () => {
		const badTarget = await actions.add!(
			event({ url: 'https://www.amazon.com/dp/B000000000', target: '24.999' })
		);
		expect(isActionFailure(badTarget)).toBe(true);
		expect(badTarget).toMatchObject({
			status: 400,
			data: {
				field: 'target',
				message: 'Enter a price in pounds, like 24.99',
				url: 'https://www.amazon.com/dp/B000000000',
				target: '24.999'
			}
		});

		const unsupported = await actions.add!(
			event({ url: 'https://www.amazon.com/dp/B000000000', target: '' })
		);
		expect(unsupported).toMatchObject({
			status: 400,
			data: {
				field: 'url',
				message: 'unsupported URL',
				url: 'https://www.amazon.com/dp/B000000000',
				target: ''
			}
		});

		const missing = await actions.add!(event({}));
		expect(missing).toMatchObject({ status: 400, data: { field: 'url', url: '', target: '' } });
		expect(state.checkUrl).not.toHaveBeenCalled();
	});

	it('add alerts', async () => {
		// Global fetch is stubbed for ntfy; the shop check is the checkUrl stub.
		const fetch = vi.fn(async () => new Response('{}', { status: 200 }));
		vi.stubGlobal('fetch', fetch);
		try {
			const key = randomBytes(32);
			setAlertsKey(key);
			await saveChannel(state.h!.db, key, 'ntfy', { topic: 'https://ntfy.sh/route-topic' });
			state.checkUrl.mockResolvedValueOnce({
				ok: true,
				shop: 'amazon-uk',
				productId: 'B0CHEAPNOW',
				canonicalUrl: 'https://www.amazon.co.uk/dp/B0CHEAPNOW',
				title: 'Cheap Now',
				pricePence: 1800,
				imageUrl: null
			});

			await actions.add!(event({ url: 'https://www.amazon.co.uk/dp/B0CHEAPNOW', target: '20' }));

			expect(fetch).toHaveBeenCalledOnce();
			const [target, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
			expect(target).toBe('https://ntfy.sh/');
			expect(JSON.parse(String(init.body))).toMatchObject({
				topic: 'route-topic',
				title: 'Price drop: Cheap Now'
			});
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it('add success', async () => {
		const ok: CheckResult = {
			ok: true,
			shop: 'amazon-uk',
			productId: 'B0NEWPROD1',
			canonicalUrl: 'https://www.amazon.co.uk/dp/B0NEWPROD1',
			title: 'New Blender',
			pricePence: 4999,
			imageUrl: null
		};
		state.checkUrl.mockResolvedValueOnce(ok);

		const result = await actions.add!(
			event({ url: 'https://www.amazon.co.uk/dp/B0NEWPROD1?tag=x', target: '40' })
		);

		expect(result).toEqual({ added: 'New Blender' });
		expect(state.checkUrl).toHaveBeenCalledExactlyOnceWith(
			'https://www.amazon.co.uk/dp/B0NEWPROD1?tag=x'
		);
		// On a fresh install, the added watch is the whole list.
		const data = (await load(event())) as { watches: { label: string; target: string }[] };
		expect(data.watches.map((w) => [w.label, w.target])).toEqual([['New Blender', '£40.00']]);

		// A stored failure is labelled by its canonical URL.
		state.checkUrl.mockResolvedValueOnce(failure('blocked', 'captcha'));
		expect(
			await actions.add!(event({ url: 'https://www.amazon.co.uk/dp/B0FAILED01', target: '' }))
		).toEqual({ added: 'https://www.amazon.co.uk/dp/B0FAILED01' });
		expect(await cards()).toHaveLength(2);
	});
});
