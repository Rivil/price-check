import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { isActionFailure, isHttpError, isRedirect } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { saveChannel } from '#lib/server/alerts/channels.ts';
import { setAlertsKey } from '#lib/server/alerts/crypto.ts';
import { checkFailure, pricePoint, watch } from '#lib/server/db/schema.ts';
import type { CheckResult } from '#lib/server/shops/types.ts';
import { createTestDb, type TestDb } from '#lib/server/testing/test-db.ts';
import type { ChartInput } from '#lib/chart.ts';
import type { PriceStats, TimelineRow } from '#lib/watch-history.ts';

// The route's db is a fresh migrated temp SQLite; checkUrl is a stub, so 'Check now'
// never reaches amazon.co.uk (r-01).
const state = vi.hoisted(() => ({
	h: null as TestDb | null,
	checkUrl: null as unknown as Mock<(url: string) => Promise<CheckResult>>
}));
vi.mock('#lib/server/shops/index.ts', async (importOriginal) => ({
	...(await importOriginal<object>()),
	checkUrl: (url: string) => state.checkUrl(url)
}));
vi.mock('#lib/server/db/index.ts', () => ({
	get db() {
		return state.h!.db;
	}
}));

const { load, actions } = await import('./+page.server.ts');

type Event = Parameters<typeof load>[0];

/** No signed-in user anywhere: the install's data is everyone's who can reach it. */
function event(id: string, form?: Record<string, string>): Event {
	return {
		locals: {},
		params: { id },
		request: new Request(`http://localhost/watches/${id}`, {
			method: 'POST',
			body: new URLSearchParams(form ?? {})
		})
	} as unknown as Event;
}

async function thrown(run: () => unknown) {
	try {
		await run();
	} catch (e) {
		return e;
	}
	throw new Error('expected a throw');
}

/** '<status> <message>' of the HttpError a run throws. */
async function status(run: () => unknown) {
	const e = await thrown(run);
	return isHttpError(e) ? `${e.status} ${e.body.message}` : e;
}

async function target(id: string) {
	const [row] = await state.h!.db.select().from(watch).where(eq(watch.id, id));
	return row === undefined ? 'gone' : row.targetPence;
}

type Page = {
	timeline: TimelineRow[];
	stats: PriceStats | null;
	chart: ChartInput | null;
	now: number;
};

async function page(id: string) {
	return (await load(event(id))) as unknown as Page;
}

let rows = 0;

function addPoint(watchId: string, pricePence: number, checkedAt: Date) {
	return state
		.h!.db.insert(pricePoint)
		.values({ id: `p${++rows}`, watchId, pricePence, checkedAt });
}

function addFailure(watchId: string, checkedAt: Date, message: string | null = null) {
	return state
		.h!.db.insert(checkFailure)
		.values({ id: `f${++rows}`, watchId, reason: 'blocked', message, checkedAt });
}

beforeEach(async () => {
	state.h = await createTestDb();
	state.checkUrl = vi.fn<(url: string) => Promise<CheckResult>>();
	const row = (id: string, productId: string) => ({
		id,
		shop: 'amazon-uk',
		productId,
		canonicalUrl: `https://www.amazon.co.uk/dp/${productId}`,
		title: `Product ${productId}`,
		pricePence: 2500,
		targetPence: 2000,
		lastCheckedAt: new Date('2026-11-01T12:00:00Z'),
		lastCheckReason: id === 'a2' ? 'blocked' : null,
		lastCheckMessage: id === 'a2' ? 'captcha page' : null
	});
	await state.h.db
		.insert(watch)
		.values([row('a1', 'B0ALICE001'), row('a2', 'B0ALICE002'), row('b1', 'B0BOB00001')]);
});
afterEach(() => state.h!.dispose());

describe('watch page', () => {
	it('load', async () => {
		expect(await load(event('a1'))).toEqual({
			timeline: [],
			stats: null,
			chart: null,
			now: expect.any(Number),
			watch: expect.objectContaining({
				id: 'a1',
				label: 'Product B0ALICE001',
				price: '£25.00',
				target: '£20.00',
				checkedAt: '1 Nov 2026, 12:00',
				failure: null
			})
		});
		expect(await load(event('a2'))).toMatchObject({
			watch: { failure: { reason: 'blocked', label: 'Blocked by Amazon', message: 'captcha page' } }
		});

		// Every watch is the install's: b1 loads like any other.
		expect(await load(event('b1'))).toMatchObject({ watch: { id: 'b1' } });
		expect(await status(() => load(event('missing')))).toBe('404 No such watch');
	});

	it('load keys', async () => {
		expect(Object.keys(await page('a1')).sort()).toEqual([
			'chart',
			'now',
			'stats',
			'timeline',
			'watch'
		]);
	});

	it('target', async () => {
		expect(await actions.target!(event('a1', { target: '19.99' }))).toEqual({ saved: true });
		expect(await target('a1')).toBe(1999);

		const invalid = await actions.target!(event('a1', { target: '24.999' }));
		expect(isActionFailure(invalid)).toBe(true);
		expect(invalid).toMatchObject({
			status: 400,
			data: { message: 'Enter a price in pounds, like 24.99', target: '24.999' }
		});
		expect(await target('a1')).toBe(1999);

		expect(await actions.target!(event('a1', {}))).toEqual({ saved: true });
		expect(await target('a1')).toBeNull();

		// Only the named watch changed; an unknown one is 404.
		expect(await target('b1')).toBe(2000);
		expect(await status(() => actions.target!(event('missing', { target: '1' })))).toBe(
			'404 No such watch'
		);
	});

	it('history', async () => {
		await state.h!.db.insert(pricePoint).values([
			{ id: 'p1', watchId: 'a1', pricePence: 2500, checkedAt: new Date('2026-10-30T08:00:00Z') },
			{ id: 'p2', watchId: 'a1', pricePence: 129900, checkedAt: new Date('2026-11-01T12:00:00Z') },
			{ id: 'p3', watchId: 'a2', pricePence: 1, checkedAt: new Date('2026-11-01T13:00:00Z') },
			{ id: 'p4', watchId: 'b1', pricePence: 2, checkedAt: new Date('2026-11-01T14:00:00Z') }
		]);

		expect((await page('a1')).timeline).toEqual([
			{ kind: 'price', price: '£1,299.00', checkedAt: '1 Nov 2026, 12:00' },
			{ kind: 'price', price: '£25.00', checkedAt: '30 Oct 2026, 08:00' }
		]);
	});

	it('timeline', async () => {
		await addPoint('a1', 2500, new Date('2026-10-30T08:00:00Z'));
		await addFailure('a1', new Date('2026-10-31T08:00:00Z'), 'captcha page');
		await addPoint('a1', 2400, new Date('2026-11-01T08:00:00Z'));

		expect((await page('a1')).timeline).toEqual([
			{ kind: 'price', checkedAt: '1 Nov 2026, 08:00', price: '£24.00' },
			{
				kind: 'failure',
				checkedAt: '31 Oct 2026, 08:00',
				reason: 'Blocked by Amazon — captcha page'
			},
			{ kind: 'price', checkedAt: '30 Oct 2026, 08:00', price: '£25.00' }
		]);
	});

	it('target in chart', async () => {
		await addPoint('a1', 2500, new Date('2026-10-30T08:00:00Z'));
		expect((await page('a1')).chart?.targetPence).toBe(2000);

		await actions.target!(event('a1', {}));
		expect((await page('a1')).chart?.targetPence).toBeNull();
	});

	it('no success', async () => {
		await addFailure('a1', new Date('2026-10-30T08:00:00Z'));
		await addFailure('a1', new Date('2026-10-31T08:00:00Z'));

		const { chart, stats, timeline } = await page('a1');

		expect(chart).toBeNull();
		expect(stats).toBeNull();
		expect(timeline.map((row) => [row.kind, row.checkedAt])).toEqual([
			['failure', '31 Oct 2026, 08:00'],
			['failure', '30 Oct 2026, 08:00']
		]);
	});

	it('stats ignore failures', async () => {
		await addPoint('a1', 2000, new Date('2026-10-29T08:00:00Z'));
		await addPoint('a1', 3000, new Date('2026-10-30T08:00:00Z'));
		const before = (await page('a1')).stats;

		await addFailure('a1', new Date('2026-10-31T08:00:00Z'));

		expect(before).toEqual({
			lowest: '£20.00',
			highest: '£30.00',
			average: '£25.00',
			change: '+50.0%'
		});
		expect((await page('a1')).stats).toEqual(before);
	});

	it('stats ignore recency', async () => {
		const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);
		await addPoint('a1', 1000, daysAgo(200));
		await addPoint('a1', 2000, daysAgo(10));
		await addPoint('a1', 3000, daysAgo(1));

		expect((await page('a1')).stats).toMatchObject({
			lowest: '£10.00',
			change: '+200.0%'
		});
	});

	it('other watch', async () => {
		await addFailure('a1', new Date('2026-10-30T08:00:00Z'));
		await addFailure('b1', new Date('2026-10-31T08:00:00Z'));

		expect((await page('a1')).timeline.map((row) => row.checkedAt)).toEqual(['30 Oct 2026, 08:00']);
		expect((await page('b1')).timeline.map((row) => row.checkedAt)).toEqual(['31 Oct 2026, 08:00']);
	});

	it('labels', async () => {
		// Summer, so UTC would read an hour behind Europe/London.
		await addPoint('a1', 2500, new Date('2026-07-01T11:00:00Z'));
		await addFailure('a1', new Date('2026-07-01T12:00:00Z'));

		// Every read of the clock moves it, so a second capture can't match the first.
		let clock = Date.UTC(2026, 10, 2);
		class TickingDate extends Date {
			constructor(...args: [number]) {
				if (args.length > 0) super(...args);
				else super((clock += 1000));
			}
			static now() {
				return (clock += 1000);
			}
		}
		vi.stubGlobal('Date', TickingDate);
		const data = await page('a1').finally(() => vi.unstubAllGlobals());

		expect(data.chart?.points[0].label).toBe('£25.00 · 1 Jul 2026, 12:00');
		expect(data.chart?.failures[0].label).toBe('Failed: Blocked by Amazon · 1 Jul 2026, 13:00');
		expect(data.chart?.now).toBe(data.now);
		expect(data.now).toBeGreaterThan(Date.UTC(2026, 10, 2));
	});

	it('check', async () => {
		const ok: CheckResult = {
			ok: true,
			shop: 'amazon-uk',
			productId: 'B0ALICE001',
			canonicalUrl: 'https://www.amazon.co.uk/dp/B0ALICE001',
			title: 'Rechecked',
			pricePence: 1999,
			imageUrl: null
		};
		state.checkUrl.mockResolvedValue(ok);

		// a1 was last checked long ago: the check runs and is recorded like a scheduled one.
		expect(await actions.check!(event('a1'))).toEqual({ checked: true });
		expect(state.checkUrl).toHaveBeenCalledExactlyOnceWith(
			'https://www.amazon.co.uk/dp/B0ALICE001'
		);
		const [row] = await state.h!.db.select().from(watch).where(eq(watch.id, 'a1'));
		expect(row).toMatchObject({ pricePence: 1999, title: 'Rechecked', lastCheckReason: null });
		expect(
			await state.h!.db.select().from(pricePoint).where(eq(pricePoint.watchId, 'a1'))
		).toHaveLength(1);

		// Checked moments ago: refused with the cooldown message, no second request.
		const refused = await actions.check!(event('a1'));
		expect(isActionFailure(refused)).toBe(true);
		expect(refused).toMatchObject({
			status: 429,
			data: { checkMessage: 'Checked less than 15 minutes ago — try again later' }
		});
		expect(state.checkUrl).toHaveBeenCalledOnce();

		// A failed check reports checked: false and keeps the price.
		state.checkUrl.mockResolvedValue({ ok: false, reason: 'blocked', message: 'captcha' });
		expect(await actions.check!(event('a2'))).toEqual({ checked: false });

		expect(await status(() => actions.check!(event('missing')))).toBe('404 No such watch');
		expect(state.checkUrl).toHaveBeenCalledTimes(2);
	});

	it('check alerts', async () => {
		// Global fetch is stubbed for ntfy; the shop check is the checkUrl stub.
		const fetch = vi.fn(async () => new Response('{}', { status: 200 }));
		vi.stubGlobal('fetch', fetch);
		try {
			const key = randomBytes(32);
			setAlertsKey(key);
			await saveChannel(state.h!.db, key, 'ntfy', { topic: 'https://ntfy.sh/page-topic' });
			state.checkUrl.mockResolvedValueOnce({
				ok: true,
				shop: 'amazon-uk',
				productId: 'B0ALICE001',
				canonicalUrl: 'https://www.amazon.co.uk/dp/B0ALICE001',
				title: 'Dropped',
				pricePence: 1900,
				imageUrl: null
			});

			expect(await actions.check!(event('a1'))).toEqual({ checked: true });

			expect(fetch).toHaveBeenCalledOnce();
			const [target, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
			expect(target).toBe('https://ntfy.sh/');
			expect(JSON.parse(String(init.body))).toMatchObject({
				topic: 'page-topic',
				message: 'Dropped is now £19.00, at or below your £20.00 target.'
			});
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it('delete', async () => {
		expect(await status(() => actions.delete!(event('missing')))).toBe('404 No such watch');

		const done = await thrown(() => actions.delete!(event('a1')));
		expect(isRedirect(done) && [done.status, done.location]).toEqual([303, '/']);
		expect(await target('a1')).toBe('gone');
		expect(await status(() => load(event('a1')))).toBe('404 No such watch');
		expect(await status(() => actions.delete!(event('a1')))).toBe('404 No such watch');
		expect(await target('a2')).toBe(2000);
		expect(await target('b1')).toBe(2000);
	});
});
