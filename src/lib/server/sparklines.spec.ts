import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pricePoint, watch } from './db/schema.ts';
import { recentPrices } from './sparklines.ts';
import { createAuthHarness, type AuthHarness } from './testing/auth-harness.ts';
import { SPARKLINE_WINDOW_MS } from '../sparkline.ts';

const NOW = new Date('2026-11-02T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const HOUR = 60 * 60 * 1000;

let h: AuthHarness;
let alice: string;
let bob: string;
let ids = 0;

beforeEach(async () => {
	h = await createAuthHarness();
	alice = (await h.createUser({ email: 'alice@example.test' })).id;
	bob = (await h.createUser({ email: 'bob@example.test' })).id;
});
afterEach(() => h.cleanup());

async function addWatch(id: string, userId: string) {
	await h.db.insert(watch).values({
		id,
		userId,
		shop: 'amazon-uk',
		productId: id,
		canonicalUrl: `https://www.amazon.co.uk/dp/${id}`
	});
}

function addPoint(watchId: string, pricePence: number, checkedAt: Date) {
	return h.db.insert(pricePoint).values({ id: `p${++ids}`, watchId, pricePence, checkedAt });
}

describe('recentPrices', () => {
	it('window edge', async () => {
		await addWatch('w1', alice);
		await addPoint('w1', 100, ago(SPARKLINE_WINDOW_MS));
		await addPoint('w1', 200, ago(SPARKLINE_WINDOW_MS + 1));

		const prices = await recentPrices(h.db, alice, NOW);

		expect(prices.get('w1')).toEqual([{ pricePence: 100, checkedAt: ago(SPARKLINE_WINDOW_MS) }]);
	});

	it('only mine', async () => {
		await addWatch('w1', alice);
		await addWatch('b1', bob);
		await addPoint('w1', 100, ago(HOUR));
		await addPoint('b1', 999, ago(HOUR));

		const prices = await recentPrices(h.db, alice, NOW);

		expect([...prices.keys()]).toEqual(['w1']);
	});

	it('one query', async () => {
		await addWatch('w1', alice);
		await addWatch('w2', alice);
		await addPoint('w1', 100, ago(2 * HOUR));
		await addPoint('w1', 150, ago(HOUR));
		await addPoint('w2', 200, ago(HOUR));
		const select = vi.spyOn(h.db, 'select');

		const prices = await recentPrices(h.db, alice, NOW);

		expect(select).toHaveBeenCalledTimes(1);
		expect(prices.get('w1')).toHaveLength(2);
		expect(prices.get('w2')).toHaveLength(1);
	});

	it('a watch with no recent prices has no entry', async () => {
		await addWatch('w1', alice);

		expect((await recentPrices(h.db, alice, NOW)).has('w1')).toBe(false);
	});
});
