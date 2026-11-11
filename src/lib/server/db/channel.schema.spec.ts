import { and, asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAuthHarness, type AuthHarness } from '../testing/auth-harness.ts';
import { notifyChannel, priceDropDelivery, user, watch } from './schema.ts';

describe('notify_channel and price_drop_delivery', () => {
	let h: AuthHarness;
	let alice: string;
	let bob: string;

	beforeEach(async () => {
		h = await createAuthHarness();
		alice = (await h.createUser({ email: 'alice@example.test' })).id;
		bob = (await h.createUser({ email: 'bob@example.test' })).id;
	});
	afterEach(() => h.cleanup());

	const addWatch = (id: string, userId: string) =>
		h.db.insert(watch).values({
			id,
			userId,
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
		await h.db.insert(notifyChannel).values({ userId: alice, kind: 'ntfy' });
		expect(await h.db.select().from(notifyChannel)).toEqual([
			{
				userId: alice,
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
		await h.db.insert(notifyChannel).values({ userId: alice, kind: 'ntfy', configEnc: 'v1:a' });
		await expect(
			h.db.insert(notifyChannel).values({ userId: alice, kind: 'ntfy', configEnc: 'v1:b' })
		).rejects.toMatchObject({
			cause: { message: expect.stringMatching(/UNIQUE constraint failed: notify_channel/) }
		});
		// Another type, or another user's ntfy, is a different channel.
		await h.db.insert(notifyChannel).values({ userId: alice, kind: 'resend' });
		await h.db.insert(notifyChannel).values({ userId: bob, kind: 'ntfy' });
		expect(await h.db.select().from(notifyChannel)).toHaveLength(3);
		const [kept] = await h.db
			.select({ configEnc: notifyChannel.configEnc })
			.from(notifyChannel)
			.where(and(eq(notifyChannel.userId, alice), eq(notifyChannel.kind, 'ntfy')));
		expect(kept.configEnc).toBe('v1:a');
	});

	it('cascade', async () => {
		// alice: w1, w2 on ntfy and resend; bob: w3 on ntfy.
		const seed = async () => {
			await h.db.delete(priceDropDelivery);
			await h.db.delete(notifyChannel);
			await h.db.delete(watch);
			for (const [id, owner] of [
				['w1', alice],
				['w2', alice],
				['w3', bob]
			] as const) {
				await addWatch(id, owner);
			}
			await h.db.insert(notifyChannel).values([
				{ userId: alice, kind: 'ntfy' },
				{ userId: alice, kind: 'resend' },
				{ userId: bob, kind: 'ntfy' }
			]);
			await h.db.insert(priceDropDelivery).values([
				{ watchId: 'w1', kind: 'ntfy', userId: alice, targetPence: 2000 },
				{ watchId: 'w1', kind: 'resend', userId: alice, targetPence: 2000 },
				{ watchId: 'w2', kind: 'ntfy', userId: alice, targetPence: 1500 },
				{ watchId: 'w3', kind: 'ntfy', userId: bob, targetPence: 900 }
			]);
			expect(await deliveries()).toEqual(['w1/ntfy', 'w1/resend', 'w2/ntfy', 'w3/ntfy']);
		};

		await seed();
		await h.db.delete(watch).where(eq(watch.id, 'w1'));
		expect(await deliveries()).toEqual(['w2/ntfy', 'w3/ntfy']);

		await seed();
		await h.db
			.delete(notifyChannel)
			.where(and(eq(notifyChannel.userId, alice), eq(notifyChannel.kind, 'ntfy')));
		expect(await deliveries()).toEqual(['w1/resend', 'w3/ntfy']);

		await seed();
		await h.db.delete(user).where(eq(user.id, alice));
		expect(await deliveries()).toEqual(['w3/ntfy']);
		expect(await h.db.select({ userId: notifyChannel.userId }).from(notifyChannel)).toEqual([
			{ userId: bob }
		]);
	});

	it('refuses a delivery row for a channel that does not exist', async () => {
		await addWatch('w1', alice);
		await expect(
			h.db
				.insert(priceDropDelivery)
				.values({ watchId: 'w1', kind: 'ntfy', userId: alice, targetPence: 2000 })
		).rejects.toMatchObject({
			cause: { message: expect.stringMatching(/FOREIGN KEY constraint failed/) }
		});
	});
});
