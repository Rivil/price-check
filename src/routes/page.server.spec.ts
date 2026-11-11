import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { isActionFailure, isHttpError } from '@sveltejs/kit';
import { saveChannel } from '#lib/server/alerts/channels.ts';
import { setAlertsKey } from '#lib/server/alerts/crypto.ts';
import { dueWatches } from '#lib/server/checks.ts';
import { pricePoint, watch } from '#lib/server/db/schema.ts';
import { failure, type CheckResult } from '#lib/server/shops/types.ts';
import { createAuthHarness, type AuthHarness } from '#lib/server/testing/auth-harness.ts';

// The route's db is the harness's temp SQLite; its shop keeps the real offline
// identify but checkUrl is a stub, so nothing here can reach amazon.co.uk (r-01).
const state = vi.hoisted(() => ({
	h: null as AuthHarness | null,
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
type User = { id: string; role?: string | null };
type Card = {
	id: string;
	status: { nextDueAt: Date | null };
	sparkline: { path: string } | null;
	sparklineLabel: string | null;
};

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const CHECKED_AT = new Date('2026-11-01T09:30:00Z');

async function cards(user: User) {
	return ((await load(event(user))) as { watches: Card[] }).watches;
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

function event(user: User | undefined, form?: Record<string, string>): Event {
	const body = new URLSearchParams(form ?? {});
	return {
		locals: { user },
		request: new Request('http://localhost/?/add', { method: 'POST', body })
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

let alice: User;
let bob: User;

beforeEach(async () => {
	state.h = await createAuthHarness();
	state.checkUrl = vi.fn<(url: string) => Promise<CheckResult>>();
	state.intervalHours = undefined;
	alice = { id: (await state.h.createUser({ email: 'alice@example.test' })).id, role: 'user' };
	bob = { id: (await state.h.createUser({ email: 'bob@example.test' })).id, role: 'user' };
	const row = (id: string, userId: string, productId: string, title: string) => ({
		id,
		userId,
		shop: 'amazon-uk',
		productId,
		canonicalUrl: `https://www.amazon.co.uk/dp/${productId}`,
		title,
		pricePence: 129900,
		lastCheckedAt: CHECKED_AT
	});
	await state.h.db
		.insert(watch)
		.values([
			row('a1', alice.id, 'B0ALICE001', 'Alice Kettle'),
			row('b1', bob.id, 'B0BOB00001', 'Bob Toaster')
		]);
});
afterEach(() => state.h!.cleanup());

describe('load', () => {
	it('load', async () => {
		const data = (await load(event(alice))) as {
			watches: { id: string; label: string; price: string }[];
		};
		expect(data.watches).toEqual([
			expect.objectContaining({ id: 'a1', label: 'Alice Kettle', price: '£1,299.00' })
		]);

		const e = await thrown(() => load(event(undefined)));
		expect(isHttpError(e) && e.status).toBe(401);
	});

	it('carries no nav data (the layout owns the header)', async () => {
		const data = (await load(event({ ...alice, role: 'admin' }))) as Record<string, unknown>;
		expect(Object.keys(data)).toStrictEqual(['watches']);
	});

	it('status interval', async () => {
		state.intervalHours = '12';
		expect((await cards(alice))[0].status.nextDueAt).toEqual(
			new Date(CHECKED_AT.getTime() + 12 * HOUR)
		);

		state.intervalHours = undefined;
		expect((await cards(alice))[0].status.nextDueAt).toEqual(
			new Date(CHECKED_AT.getTime() + 6 * HOUR)
		);
	});

	it('matches scheduler', async () => {
		const nextDueAt = (await cards(alice))[0].status.nextDueAt as Date;
		const dueAt = async (at: Date) =>
			(await dueWatches(state.h!.db, at, 6 * HOUR)).map((due) => due.id);

		expect(await dueAt(nextDueAt)).toContain('a1');
		expect(await dueAt(new Date(nextDueAt.getTime() - 1))).not.toContain('a1');
	});

	it('sparkline only mine', async () => {
		await addPoints('a1', [
			[40, 9900],
			[20, 2000],
			[10, 1800]
		]);
		await addPoints('b1', [[5, 100]]);

		const [card] = await cards(alice);

		expect(card.sparkline?.path.match(/[ML]/g)).toHaveLength(2);
		expect(card.sparklineLabel).toBe('30-day prices, lowest £18.00, highest £20.00');
		expect((await cards(bob))[0].sparkline?.path.match(/[ML]/g)).toHaveLength(1);
	});

	it('no sparkline without recent prices', async () => {
		await addPoints('a1', [[40, 9900]]);

		expect(await cards(alice)).toEqual([
			expect.objectContaining({ sparkline: null, sparklineLabel: null })
		]);
	});
});

describe('actions.add', () => {
	it('add refusals', async () => {
		const badTarget = await actions.add!(
			event(alice, { url: 'https://www.amazon.com/dp/B000000000', target: '24.999' })
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
			event(alice, { url: 'https://www.amazon.com/dp/B000000000', target: '' })
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

		const missing = await actions.add!(event(alice, {}));
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
			await saveChannel(state.h!.db, key, alice.id, 'ntfy', {
				topic: 'https://ntfy.sh/alice-route'
			});
			state.checkUrl.mockResolvedValueOnce({
				ok: true,
				shop: 'amazon-uk',
				productId: 'B0CHEAPNOW',
				canonicalUrl: 'https://www.amazon.co.uk/dp/B0CHEAPNOW',
				title: 'Cheap Now',
				pricePence: 1800,
				imageUrl: null
			});

			await actions.add!(
				event(alice, { url: 'https://www.amazon.co.uk/dp/B0CHEAPNOW', target: '20' })
			);

			expect(fetch).toHaveBeenCalledOnce();
			const [target, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
			expect(target).toBe('https://ntfy.sh/');
			expect(JSON.parse(String(init.body))).toMatchObject({
				topic: 'alice-route',
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
			event(alice, { url: 'https://www.amazon.co.uk/dp/B0NEWPROD1?tag=x', target: '40' })
		);

		expect(result).toEqual({ added: 'New Blender' });
		expect(state.checkUrl).toHaveBeenCalledExactlyOnceWith(
			'https://www.amazon.co.uk/dp/B0NEWPROD1?tag=x'
		);
		const data = (await load(event(alice))) as { watches: { label: string; target: string }[] };
		expect(data.watches.map((w) => [w.label, w.target])).toContainEqual(['New Blender', '£40.00']);

		// A stored failure is labelled by its canonical URL.
		state.checkUrl.mockResolvedValueOnce(failure('blocked', 'captcha'));
		expect(
			await actions.add!(
				event(alice, { url: 'https://www.amazon.co.uk/dp/B0FAILED01', target: '' })
			)
		).toEqual({ added: 'https://www.amazon.co.uk/dp/B0FAILED01' });

		const e = await thrown(() => actions.add!(event(undefined, { url: 'x', target: '' })));
		expect(isHttpError(e) && e.status).toBe(401);
	});
});
