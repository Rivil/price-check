import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createAuthHarness, type AuthHarness } from '../testing/auth-harness.ts';
import { alertChannel, user } from './schema.ts';

let h: AuthHarness;
let alice: string;
let bob: string;

beforeEach(async () => {
	h = await createAuthHarness();
	alice = (await h.createUser({ email: 'alice@example.test' })).id;
	bob = (await h.createUser({ email: 'bob@example.test' })).id;
});
afterEach(() => h.cleanup());

describe('alert_channel table', () => {
	it('channel', async () => {
		await h.db.insert(alertChannel).values({ userId: alice, ntfyUrl: 'https://ntfy.sh/alice-a1' });
		await h.db.insert(alertChannel).values({ userId: bob, ntfyUrl: 'https://ntfy.sh/bob-b2' });

		// One channel per user: a second row for alice is refused.
		await expect(
			h.db.insert(alertChannel).values({ userId: alice, ntfyUrl: 'https://ntfy.sh/other' })
		).rejects.toMatchObject({
			cause: { message: expect.stringMatching('UNIQUE constraint failed: alert_channel.user_id') }
		});

		const [row] = await h.db.select().from(alertChannel).where(eq(alertChannel.userId, alice));
		// No token unless one is given: public servers like ntfy.sh need none.
		expect(row).toMatchObject({
			userId: alice,
			ntfyUrl: 'https://ntfy.sh/alice-a1',
			ntfyToken: null
		});
		await h.db
			.update(alertChannel)
			.set({ ntfyToken: 'tk_abcdefghijklmnopqrstuvwxyz012' })
			.where(eq(alertChannel.userId, bob));
		const [bobRow] = await h.db.select().from(alertChannel).where(eq(alertChannel.userId, bob));
		expect(bobRow.ntfyToken).toBe('tk_abcdefghijklmnopqrstuvwxyz012');
		expect(row.updatedAt).toBeInstanceOf(Date);

		// Deleting a user deletes their channel.
		await h.db.delete(user).where(eq(user.id, alice));
		const rows = await h.db.select({ userId: alertChannel.userId }).from(alertChannel);
		expect(rows).toEqual([{ userId: bob }]);
	});

	it('a channel needs a URL and a real user', async () => {
		await expect(
			h.db
				.insert(alertChannel)
				.values({ userId: alice } as unknown as typeof alertChannel.$inferInsert)
		).rejects.toMatchObject({
			cause: {
				message: expect.stringMatching('NOT NULL constraint failed: alert_channel.ntfy_url')
			}
		});
		await expect(
			h.db.insert(alertChannel).values({ userId: 'nobody', ntfyUrl: 'https://ntfy.sh/x' })
		).rejects.toMatchObject({
			cause: { message: expect.stringMatching('FOREIGN KEY constraint failed') }
		});
	});
});
