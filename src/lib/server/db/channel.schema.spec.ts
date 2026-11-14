import { asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../testing/test-db.ts';
import { notifyChannel, priceDropDelivery, watch } from './schema.ts';

describe('notify_channel and price_drop_delivery', () => {
	let h: TestDb;

	beforeEach(async () => {
		h = await createTestDb();
	});
	afterEach(() => h.dispose());

	const addWatch = (id: string) =>
		h.db.insert(watch).values({
			id,
			shop: 'amazon-uk',
			productId: id,
			canonicalUrl: `https://www.amazon.co.uk/dp/${id}`
		});

	const deliveries = async () =>
		(
			await h.db
				.select({ watchId: priceDropDelivery.watchId, kind: priceDropDelivery.kind })
				.from(priceDropDelivery)
				.orderBy(asc(priceDropDelivery.watchId), asc(priceDropDelivery.kind))
		).map((row) => `${row.watchId}/${row.kind}`);

	it('defaults a new channel to enabled for both kinds, config not yet set', async () => {
		await h.db.insert(notifyChannel).values({ kind: 'ntfy' });
		expect(await h.db.select().from(notifyChannel)).toEqual([
			{
				kind: 'ntfy',
				enabled: true,
				priceDrops: true,
				checkFailures: true,
				configEnc: null,
				updatedAt: expect.any(Date)
			}
		]);
	});

	it('one per type', async () => {
		await h.db.insert(notifyChannel).values({ kind: 'ntfy', configEnc: 'v1:a' });
		await expect(
			h.db.insert(notifyChannel).values({ kind: 'ntfy', configEnc: 'v1:b' })
		).rejects.toMatchObject({
			cause: { message: expect.stringMatching(/UNIQUE constraint failed: notify_channel\.kind/) }
		});
		// Another type is a different channel.
		await h.db.insert(notifyChannel).values({ kind: 'resend' });
		expect(await h.db.select().from(notifyChannel)).toHaveLength(2);
		const [kept] = await h.db
			.select({ configEnc: notifyChannel.configEnc })
			.from(notifyChannel)
			.where(eq(notifyChannel.kind, 'ntfy'));
		expect(kept.configEnc).toBe('v1:a');
	});

	it('cascade', async () => {
		// w1 on ntfy and resend, w2 on ntfy.
		const seed = async () => {
			await h.db.delete(priceDropDelivery);
			await h.db.delete(notifyChannel);
			await h.db.delete(watch);
			await addWatch('w1');
			await addWatch('w2');
			await h.db.insert(notifyChannel).values([{ kind: 'ntfy' }, { kind: 'resend' }]);
			await h.db.insert(priceDropDelivery).values([
				{ watchId: 'w1', kind: 'ntfy', targetPence: 2000 },
				{ watchId: 'w1', kind: 'resend', targetPence: 2000 },
				{ watchId: 'w2', kind: 'ntfy', targetPence: 1500 }
			]);
			expect(await deliveries()).toEqual(['w1/ntfy', 'w1/resend', 'w2/ntfy']);
		};

		await seed();
		await h.db.delete(watch).where(eq(watch.id, 'w1'));
		expect(await deliveries()).toEqual(['w2/ntfy']);

		await seed();
		await h.db.delete(notifyChannel).where(eq(notifyChannel.kind, 'ntfy'));
		expect(await deliveries()).toEqual(['w1/resend']);
	});

	it('refuses a delivery row for a channel that does not exist', async () => {
		await addWatch('w1');
		await h.db.insert(notifyChannel).values({ kind: 'resend' });
		await expect(
			h.db.insert(priceDropDelivery).values({ watchId: 'w1', kind: 'ntfy', targetPence: 2000 })
		).rejects.toMatchObject({
			cause: { message: expect.stringMatching(/FOREIGN KEY constraint failed/) }
		});
		expect(await deliveries()).toEqual([]);
	});
});
