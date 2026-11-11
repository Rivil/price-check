import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createAuthHarness, type AuthHarness } from '../testing/auth-harness.ts';
import { pricePoint, watch } from './schema.ts';

let h: AuthHarness;

beforeEach(async () => {
	h = await createAuthHarness();
	const userId = (await h.createUser({ email: 'alice@example.test' })).id;
	for (const id of ['w1', 'w2']) {
		await h.db.insert(watch).values({
			id,
			userId,
			shop: 'amazon-uk',
			productId: `B0${id.toUpperCase()}000000`.slice(0, 10),
			canonicalUrl: `https://www.amazon.co.uk/dp/${id}`
		});
	}
});
afterEach(() => h.cleanup());

const point = (id: string, watchId: string) => ({
	id,
	watchId,
	pricePence: 1999,
	checkedAt: new Date(1_700_000_000_000)
});

describe('price_point table', () => {
	it('stores a point', async () => {
		await h.db.insert(pricePoint).values(point('p1', 'w1'));

		expect(await h.db.select().from(pricePoint)).toEqual([
			{ id: 'p1', watchId: 'w1', pricePence: 1999, checkedAt: new Date(1_700_000_000_000) }
		]);
	});

	it('price and time are required', async () => {
		// Drizzle wraps the driver error; SQLite's own message is on the cause.
		for (const [column, values] of [
			['price_pence', { id: 'p1', watchId: 'w1', checkedAt: new Date() }],
			['checked_at', { id: 'p2', watchId: 'w1', pricePence: 100 }]
		] as const) {
			await expect(
				h.db.insert(pricePoint).values(values as unknown as typeof pricePoint.$inferInsert),
				column
			).rejects.toMatchObject({
				cause: {
					message: expect.stringMatching(`NOT NULL constraint failed: price_point.${column}`)
				}
			});
		}
	});

	it('deleting a watch deletes its points', async () => {
		await h.db.insert(pricePoint).values([point('p1', 'w1'), point('p2', 'w1'), point('p3', 'w2')]);

		await h.db.delete(watch).where(eq(watch.id, 'w1'));

		const rows = await h.db.select({ id: pricePoint.id }).from(pricePoint);
		expect(rows.map((r) => r.id)).toEqual(['p3']);
	});

	it('a point needs a real watch', async () => {
		await expect(h.db.insert(pricePoint).values(point('p1', 'nope'))).rejects.toMatchObject({
			cause: { message: expect.stringMatching('FOREIGN KEY constraint failed') }
		});
	});
});
