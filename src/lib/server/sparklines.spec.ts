import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pricePoint, watch } from './db/schema.ts';
import { recentPrices } from './sparklines.ts';
import { createTestDb, type TestDb } from './testing/test-db.ts';
import { SPARKLINE_WINDOW_MS } from '../sparkline.ts';

const NOW = new Date('2026-11-02T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const HOUR = 60 * 60 * 1000;

let h: TestDb;
let ids = 0;

beforeEach(async () => {
	h = await createTestDb();
});
afterEach(() => h.dispose());

async function addWatch(id: string) {
	await h.db.insert(watch).values({
		id,
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
		await addWatch('w1');
		await addPoint('w1', 100, ago(SPARKLINE_WINDOW_MS));
		await addPoint('w1', 200, ago(SPARKLINE_WINDOW_MS + 1));

		const prices = await recentPrices(h.db, NOW);

		expect(prices.get('w1')).toEqual([{ pricePence: 100, checkedAt: ago(SPARKLINE_WINDOW_MS) }]);
	});

	it('every watch, only the window', async () => {
		await addWatch('w1');
		await addWatch('w2');
		await addPoint('w1', 100, ago(HOUR));
		await addPoint('w1', 111, ago(31 * 24 * HOUR));
		await addPoint('w2', 999, ago(HOUR));
		await addPoint('w2', 888, ago(SPARKLINE_WINDOW_MS + 1));

		const prices = await recentPrices(h.db, NOW);

		expect(Object.fromEntries(prices)).toEqual({
			w1: [{ pricePence: 100, checkedAt: ago(HOUR) }],
			w2: [{ pricePence: 999, checkedAt: ago(HOUR) }]
		});
	});

	it('one query', async () => {
		await addWatch('w1');
		await addWatch('w2');
		await addPoint('w1', 100, ago(2 * HOUR));
		await addPoint('w1', 150, ago(HOUR));
		await addPoint('w2', 200, ago(HOUR));
		const select = vi.spyOn(h.db, 'select');

		const prices = await recentPrices(h.db, NOW);

		expect(select).toHaveBeenCalledTimes(1);
		expect(prices.get('w1')).toHaveLength(2);
		expect(prices.get('w2')).toHaveLength(1);
	});

	it('a watch with no recent prices has no entry', async () => {
		await addWatch('w1');

		expect((await recentPrices(h.db, NOW)).has('w1')).toBe(false);
	});
});
